import crypto from 'crypto';
import mongoose from 'mongoose';
import KMSBackup, { type IKMSBackup, type IKMSBackupEntry } from '../models/KMSBackup.model';
import KMSKey from '../models/KMSKey.model';
import { AppError } from '../errors/AppError';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function resolveKey(name: 'KMS_MASTER_KEY' | 'KMS_BACKUP_MASTER_KEY'): Buffer {
  const value = name === 'KMS_MASTER_KEY'
    ? process.env.KMS_MASTER_KEY ?? process.env.MASTER_KEY
    : process.env[name];
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    const setting = name === 'KMS_MASTER_KEY' ? 'MASTER_KEY' : name;
    throw new AppError(`${setting} must be configured as a 64-character hex key`, 500, 'KMS_BACKUP_CONFIG_INVALID');
  }
  return Buffer.from(value, 'hex');
}

function associatedData(ownerId: string, keyId: string, keyVersion: string): Buffer {
  return Buffer.from(`${ownerId}:${keyId}:${keyVersion}`, 'utf8');
}

function unwrapKey(encryptedKeyValue: string, ivHex: string, authTagHex: string, masterKey: Buffer): Buffer {
  const ciphertext = Buffer.from(encryptedKeyValue, 'base64');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  if (ciphertext.length !== KEY_LENGTH || iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new AppError('A KMS key has an unsupported wrapping format', 422, 'KMS_KEY_FORMAT_UNSUPPORTED');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptEscrow(dataKey: Buffer, ownerId: string, keyId: string, keyVersion: string, backupKey: Buffer) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, backupKey, iv);
  cipher.setAAD(associatedData(ownerId, keyId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

function decryptEscrow(entry: IKMSBackupEntry, ownerId: string, backupKey: Buffer): Buffer {
  const ciphertext = Buffer.from(entry.ciphertext, 'base64');
  const iv = Buffer.from(entry.iv, 'hex');
  const authTag = Buffer.from(entry.authTag, 'hex');
  if (ciphertext.length !== KEY_LENGTH || iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new AppError('A backup entry has an invalid encrypted payload', 422, 'KMS_BACKUP_INVALID');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, backupKey, iv);
  decipher.setAAD(associatedData(ownerId, String(entry.keyId), entry.keyVersion));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrapKey(dataKey: Buffer, masterKey: Buffer) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { encryptedKeyValue: ciphertext.toString('base64'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

export class KmsBackupService {
  async create(ownerId: string, actorId: string) {
    if (!mongoose.Types.ObjectId.isValid(ownerId) || !mongoose.Types.ObjectId.isValid(actorId)) {
      throw new AppError('Invalid user ID', 400, 'INVALID_USER_ID');
    }
    const masterKey = resolveKey('KMS_MASTER_KEY');
    const backupKey = resolveKey('KMS_BACKUP_MASTER_KEY');
    if (masterKey.equals(backupKey)) {
      throw new AppError('KMS_BACKUP_MASTER_KEY must be independent from KMS_MASTER_KEY', 500, 'KMS_BACKUP_CONFIG_INVALID');
    }
    const session = await mongoose.startSession();
    let created: IKMSBackup | undefined;
    try {
      await session.withTransaction(async () => {
        const keys = await KMSKey.find({ creatorId: ownerId }).sort({ createdAt: 1 }).session(session).exec();
        if (keys.length === 0) throw new AppError('No KMS keys are available to back up', 404, 'KMS_KEYS_NOT_FOUND');
        const entries = keys.map((key) => {
          const keyId = String(key._id);
          const dataKey = unwrapKey(key.encryptedKeyValue, key.iv, key.authTag, masterKey);
          return {
            keyId: key._id,
            keyVersion: key.keyVersion,
            algorithm: key.algorithm,
            ...encryptEscrow(dataKey, ownerId, keyId, key.keyVersion, backupKey),
            isActive: key.isActive,
            ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
          };
        });
        const backup = new KMSBackup({ ownerId, createdBy: actorId, keys: entries });
        await backup.save({ session });
        created = backup;
      });
      if (!created) throw new AppError('KMS backup did not complete', 500, 'KMS_BACKUP_FAILED');
      return created;
    } finally {
      await session.endSession();
    }
  }

  list(ownerId: string) {
    return KMSBackup.find({ ownerId }).select('_id ownerId createdBy createdAt updatedAt keys.keyId keys.keyVersion keys.isActive').sort({ createdAt: -1 }).exec();
  }

  async restore(ownerId: string, backupId: string): Promise<{ restoredKeys: number }> {
    if (!mongoose.Types.ObjectId.isValid(ownerId) || !mongoose.Types.ObjectId.isValid(backupId)) {
      throw new AppError('Invalid user or backup ID', 400, 'INVALID_BACKUP_ID');
    }
    const masterKey = resolveKey('KMS_MASTER_KEY');
    const backupKey = resolveKey('KMS_BACKUP_MASTER_KEY');
    if (masterKey.equals(backupKey)) {
      throw new AppError('KMS_BACKUP_MASTER_KEY must be independent from KMS_MASTER_KEY', 500, 'KMS_BACKUP_CONFIG_INVALID');
    }
    const backup = await KMSBackup.findOne({ _id: backupId, ownerId }).exec();
    if (!backup) throw new AppError('KMS backup not found', 404, 'KMS_BACKUP_NOT_FOUND');

    const operations = backup.keys.map((entry) => {
      const dataKey = decryptEscrow(entry, ownerId, backupKey);
      const wrapped = wrapKey(dataKey, masterKey);
      const keyUpdate: Record<string, unknown> = {
        creatorId: backup.ownerId,
        keyVersion: entry.keyVersion,
        algorithm: entry.algorithm,
        ...wrapped,
        isActive: entry.isActive,
      };
      if (entry.expiresAt) keyUpdate.expiresAt = entry.expiresAt;
      return {
        updateOne: {
          filter: { _id: entry.keyId },
          update: { $set: keyUpdate, ...(entry.expiresAt ? {} : { $unset: { expiresAt: 1 } }) },
          upsert: true,
        },
      };
    });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await KMSKey.updateMany(
          { creatorId: backup.ownerId, isActive: true },
          { $set: { isActive: false } },
          { session }
        );
        await KMSKey.bulkWrite(operations, { ordered: true, session });
      });
    } finally {
      await session.endSession();
    }
    return { restoredKeys: operations.length };
  }
}

export const kmsBackupService = new KmsBackupService();
