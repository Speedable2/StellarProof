import crypto from 'crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import KMSKey from '../../models/KMSKey.model';
import KMSBackup from '../../models/KMSBackup.model';
import { kmsBackupService } from '../kmsBackup.service';

jest.setTimeout(180_000);

const MASTER_KEY = crypto.randomBytes(32);
const BACKUP_KEY = crypto.randomBytes(32);
const OWNER_ID = new mongoose.Types.ObjectId();

function wrap(dataKey: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { encryptedKeyValue: ciphertext.toString('base64'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

function unwrap(key: { encryptedKeyValue: string; iv: string; authTag: string }): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(key.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(key.authTag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(key.encryptedKeyValue, 'base64')), decipher.final()]);
}

describe('KmsBackupService integration', () => {
  let replicaSet: MongoMemoryReplSet;

  beforeAll(async () => {
    process.env.KMS_MASTER_KEY = MASTER_KEY.toString('hex');
    process.env.KMS_BACKUP_MASTER_KEY = BACKUP_KEY.toString('hex');
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replicaSet.stop();
    delete process.env.KMS_MASTER_KEY;
    delete process.env.KMS_BACKUP_MASTER_KEY;
  });

  beforeEach(async () => {
    await Promise.all([KMSKey.deleteMany({}), KMSBackup.deleteMany({})]);
  });

  it('escrows KMS keys under the recovery key and restores deleted key records', async () => {
    const dataKey = crypto.randomBytes(32);
    const original = await KMSKey.create({
      creatorId: OWNER_ID, keyVersion: 'v4', algorithm: 'AES-256-GCM', ...wrap(dataKey), isActive: true,
    });

    const backup = await kmsBackupService.create(String(OWNER_ID), String(OWNER_ID));
    const escrowEntry = backup.keys[0];
    expect(escrowEntry.ciphertext).not.toContain(dataKey.toString('base64'));
    const newerKey = await KMSKey.create({
      creatorId: OWNER_ID, keyVersion: 'v5', algorithm: 'AES-256-GCM', ...wrap(crypto.randomBytes(32)), isActive: true,
    });
    expect(await KMSKey.deleteOne({ _id: original._id }).exec()).toMatchObject({ deletedCount: 1 });

    await expect(kmsBackupService.restore(String(OWNER_ID), String(backup._id))).resolves.toEqual({ restoredKeys: 1 });

    const restored = await KMSKey.findById(original._id).exec();
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({ creatorId: OWNER_ID, keyVersion: 'v4', isActive: true });
    expect(unwrap(restored!)).toEqual(dataKey);
    expect(await KMSKey.findById(newerKey._id).then((key) => key?.isActive)).toBe(false);
    expect(await KMSKey.countDocuments({ creatorId: OWNER_ID, isActive: true })).toBe(1);
  });

  it('does not expose another user\'s backup and rejects tampered escrow data', async () => {
    const dataKey = crypto.randomBytes(32);
    await KMSKey.create({ creatorId: OWNER_ID, keyVersion: 'v1', algorithm: 'AES-256-GCM', ...wrap(dataKey), isActive: true });
    const backup = await kmsBackupService.create(String(OWNER_ID), String(OWNER_ID));
    const otherOwnerId = new mongoose.Types.ObjectId();

    await expect(kmsBackupService.restore(String(otherOwnerId), String(backup._id))).rejects.toMatchObject({ code: 'KMS_BACKUP_NOT_FOUND' });
    await KMSBackup.updateOne({ _id: backup._id }, { $set: { 'keys.0.ciphertext': Buffer.alloc(32).toString('base64') } });
    await expect(kmsBackupService.restore(String(OWNER_ID), String(backup._id))).rejects.toThrow();
    expect(await KMSKey.countDocuments({ creatorId: OWNER_ID })).toBe(1);
  });
});
