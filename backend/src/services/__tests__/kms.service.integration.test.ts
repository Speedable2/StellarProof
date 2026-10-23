import crypto from 'crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import KMSKey from '../../models/KMSKey.model';
import Asset from '../../models/Asset.model';
import SPVRecord from '../../models/SPVRecord.model';
import { kmsService } from '../kms.service';
import { ipfsService } from '../ipfs.service';

jest.setTimeout(180_000);

const mockCloudinaryState = { uploads: [] as Buffer[], destroy: jest.fn() };
const mockPinataUploads: Buffer[] = [];
const storedBlobs = new Map<string, Buffer>();

jest.mock('cloudinary', () => ({
  v2: {
    url: (reference: string) => `https://cloudinary.test/${reference}`,
    uploader: {
      upload_stream: (_options: unknown, callback: (error: unknown, result: unknown) => void) => {
        const chunks: Buffer[] = [];
        const { Writable } = require('stream') as typeof import('stream');
        return new Writable({
          write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
          final(done) {
            const buffer = Buffer.concat(chunks);
            mockCloudinaryState.uploads.push(buffer);
            const publicId = `rotated/${mockCloudinaryState.uploads.length}`;
            callback(undefined, { public_id: publicId, secure_url: `https://cloudinary.test/${publicId}` });
            done();
          },
        });
      },
      destroy: (...args: unknown[]) => mockCloudinaryState.destroy(...args),
    },
  },
}));

jest.mock('../ipfs.service', () => ({ ipfsService: { upload: jest.fn(), unpin: jest.fn() } }));

const USER_ID = new mongoose.Types.ObjectId();
const MASTER_KEY = crypto.randomBytes(32);

function wrapDataKey(dataKey: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { encryptedKeyValue: ciphertext.toString('base64'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

function unwrapDataKey(key: { encryptedKeyValue: string; iv: string; authTag: string }): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(key.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(key.authTag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(key.encryptedKeyValue, 'base64')), decipher.final()]);
}

function encryptBlob(plaintext: Buffer, dataKey: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), iv, ciphertext]);
}

function decryptBlob(blob: Buffer, dataKey: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, blob.subarray(16, 28));
  decipher.setAuthTag(blob.subarray(0, 16));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

async function createUserAssets(count: number) {
  const originalDataKeys: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const dataKey = crypto.randomBytes(32);
    originalDataKeys.push(dataKey);
    const kmsKey = await KMSKey.create({
      creatorId: USER_ID, keyVersion: 'v1', algorithm: 'AES-256-GCM', ...wrapDataKey(dataKey), isActive: true,
    });
    const storageProvider = index % 2 === 0 ? 'cloudinary' : 'ipfs';
    const reference = `assets/${index}`;
    const encrypted = encryptBlob(Buffer.from(`asset plaintext ${index}`), dataKey);
    const url = storageProvider === 'cloudinary'
      ? `https://cloudinary.test/${reference}`
      : `https://pinata.test/ipfs/${reference}`;
    storedBlobs.set(url, encrypted);
    const asset = await Asset.create({
      creatorId: USER_ID, fileName: `asset-${index}.bin`, mimeType: 'application/octet-stream', sizeBytes: encrypted.length,
      storageProvider, storageReferenceId: reference, isEncrypted: true, encryptionKeyVersion: 'v1',
    });
    await SPVRecord.create({ assetId: asset._id, creatorId: USER_ID, kmsKeyId: kmsKey._id, accessType: 'private', isSealed: true });
  }
  return originalDataKeys;
}

describe('KmsService.rotateKey MongoDB integration', () => {
  let replicaSet: MongoMemoryReplSet;

  beforeAll(async () => {
    process.env.KMS_MASTER_KEY = MASTER_KEY.toString('hex');
    process.env.PINATA_GATEWAY_URL = 'https://pinata.test/ipfs';
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replicaSet.stop();
    delete process.env.KMS_MASTER_KEY;
    delete process.env.PINATA_GATEWAY_URL;
  });

  beforeEach(async () => {
    await Promise.all([KMSKey.deleteMany({}), Asset.deleteMany({}), SPVRecord.deleteMany({})]);
    storedBlobs.clear();
    mockCloudinaryState.uploads.length = 0;
    mockPinataUploads.length = 0;
    mockCloudinaryState.destroy.mockReset().mockResolvedValue({ result: 'ok' });
    jest.mocked(ipfsService.upload).mockReset().mockImplementation(async (input) => {
      if (!(input.content instanceof Buffer)) throw new Error('Expected encrypted bytes');
      mockPinataUploads.push(Buffer.from(input.content));
      const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3f3o6cegofk4ymq7z7wbq2i4e';
      return {
        cid,
        cidVersion: 1,
        size: input.content.length,
        name: input.name ?? 'asset',
        timestamp: new Date().toISOString(),
        gatewayUrl: `https://pinata.test/ipfs/${cid}`,
        pinId: 'mock-pin-id',
        pinningStatus: 'pinned',
        availability: { available: true, httpStatus: 200, checkedAt: new Date().toISOString() },
      };
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const blob = storedBlobs.get(String(input));
      if (!blob) return new Response('', { status: 404 });
      return new Response(new Uint8Array(blob), { status: 200 });
    }) as typeof fetch;
  });

  it('changes every stored ciphertext and preserves plaintext under a newly wrapped key', async () => {
    const originalDataKeys = await createUserAssets(2);
    const originalCiphertexts = [
      storedBlobs.get('https://cloudinary.test/assets/0')!,
      storedBlobs.get('https://pinata.test/ipfs/assets/1')!,
    ];
    const result = await kmsService.rotateKey(String(USER_ID));

    expect(result).toEqual({ oldKeyVersion: 'v1', newKeyVersion: 'v2', assetsReEncrypted: 2 });
    expect(mockCloudinaryState.uploads).toHaveLength(1);
    expect(mockPinataUploads).toHaveLength(1);
    const newKey = await KMSKey.findOne({ creatorId: USER_ID, keyVersion: 'v2' });
    expect(newKey).not.toBeNull();
    const rotatedDataKey = unwrapDataKey(newKey!);
    const rotatedBlobs = [mockCloudinaryState.uploads[0], mockPinataUploads[0]];
    for (const [index, encrypted] of rotatedBlobs.entries()) {
      expect(decryptBlob(encrypted, rotatedDataKey).toString()).toBe(`asset plaintext ${index}`);
      expect(encrypted).not.toEqual(originalCiphertexts[index]);
      expect(originalDataKeys[index]).not.toEqual(rotatedDataKey);
    }
    const records = await SPVRecord.find({ creatorId: USER_ID });
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => String(record.kmsKeyId)))).toEqual(new Set([String(newKey!._id)]));
    expect(await KMSKey.countDocuments({ creatorId: USER_ID, isActive: true })).toBe(1);
  });

  it('aborts database changes and removes newly uploaded blobs on a mid-rotation failure', async () => {
    await createUserAssets(2);
    storedBlobs.delete('https://pinata.test/ipfs/assets/1');

    await expect(kmsService.rotateKey(String(USER_ID))).rejects.toThrow('Failed to re-encrypt asset');

    expect(await KMSKey.countDocuments({ creatorId: USER_ID })).toBe(2);
    expect(await KMSKey.countDocuments({ creatorId: USER_ID, isActive: true })).toBe(2);
    expect(await Asset.countDocuments({ creatorId: USER_ID, encryptionKeyVersion: 'v1' })).toBe(2);
    expect(await SPVRecord.countDocuments({ creatorId: USER_ID })).toBe(2);
    expect(mockCloudinaryState.destroy).toHaveBeenCalledWith('rotated/1', { resource_type: 'raw' });
    expect(ipfsService.upload).not.toHaveBeenCalled();
  });
});
