import crypto from 'crypto';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import { Readable } from 'stream';
import KMSKey, { IKMSKey } from '../models/KMSKey.model';
import Asset, { IAsset } from '../models/Asset.model';
import SPVRecordModel from '../models/SPVRecord.model';
import { AppError } from '../errors/AppError';
import { ipfsService } from './ipfs.service';
import { kmsAuditService } from './kmsAudit.service';
import { v2 as cloudinary, UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../errors/AppError';
import logger from '../utils/logger';

function unexpiredFilter(now: Date = new Date()) {
  return {
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce is standard for GCM buffers
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const DATA_KEY_LENGTH = 32; // AES-256 data key

function unexpiredFilter(now: Date): Record<string, unknown> {
  return {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  };
}

export interface RotateKeyResult {
  oldKeyVersion: string;
  newKeyVersion: string;
  assetsReEncrypted: number;
}

export interface KeyVersionSummary {
  keyId: string;
  version: string;
  keyVersion: string;
  status: 'active' | 'retired' | 'expired';
  algorithm: string;
  isActive: boolean;
  expiresAt?: Date | null;
  createdAt: Date;
  assetCount: number;
}

export interface KeySummaryReport {
  userId: string;
  active: number;
  retired: number;
  expired: number;
  total: number;
  counts: {
    active: number;
    retired: number;
    expired: number;
    total: number;
  };
  assetsPerVersion: Record<string, number>;
  versions: KeyVersionSummary[];
}

/** A blob stored by a provider, identified by the reference the Asset holds. */
interface StorageRef {
  provider: 'cloudinary' | 'ipfs';
  reference: string;
}

/** Blobs written or replaced during a rotation, used for storage cleanup. */
interface BlobTracker {
  uploaded: StorageRef[];
  replaced: StorageRef[];
}

/** Parses a key version such as `v3`. */
function parseKeyVersion(keyVersion: string): number {
  const match = keyVersion.match(/^v(\d+)$/);
  if (!match) throw new Error(`Invalid key version format: ${keyVersion}`);
  return parseInt(match[1], 10);
}

/** A symmetric key wrapped (encrypted) by a master key, in the hex format stored on KMSKey. */
interface WrappedKey {
  encrypted: string;
  iv: string;
  authTag: string;
}

type WrappedKeyRecord = Pick<IKMSKey, 'encryptedKeyValue' | 'iv' | 'authTag'>;

export interface MasterKeys {
  current: Buffer;
  previous?: Buffer;
}

export interface KeyRewrapSummary {
  scanned: number;
  rewrapped: number;
  alreadyCurrent: number;
  failed: string[];
}

/**
 * Resolves the 256-bit master keys from validated configuration.
 * Loaded lazily so importing this module never triggers environment validation.
 * Keys are derived with SHA-256 as before, so symmetric keys wrapped under an
 * existing MASTER_KEY remain decryptable.
 */
function resolveMasterKeys(): MasterKeys {
  const { env } = require('../config/env') as typeof import('../config/env');
  const derive = (secret: string): Buffer => crypto.createHash('sha256').update(secret).digest();

  return {
    current: derive(env.MASTER_KEY),
    previous: env.MASTER_KEY_PREVIOUS ? derive(env.MASTER_KEY_PREVIOUS) : undefined,
  };
}

/** Filter matching keys that have no expiry or whose expiry is still in the future. */
function unexpiredFilter(now: Date) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

export class KmsService {
  /**
   * Generates a new 256-bit symmetric key for encryption
   */
  generateSymmetricKey(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * Encrypts a buffer using AES-256-GCM.
   * Returns a concatenated buffer: [IV (12 bytes) + Ciphertext + Auth Tag (16 bytes)]
   * @param buffer The plaintext buffer to encrypt
   * @param key A 32-byte (256-bit) encryption key
   */
  encryptBuffer(buffer: Buffer, key: Buffer): Buffer {
    if (key.length !== 32) {
      throw new Error('Invalid KMS key length. AES-256 requires exactly a 32-byte key.');
    }

    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

      const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Ensure the auth tag is appended to the payload per requirements
      return Buffer.concat([iv, ciphertext, authTag]);
    } catch (error) {
      throw new Error(`KMS Encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Decrypts an AES-256-GCM encrypted buffer.
   * Expects the exact packed format: [IV (12 bytes) + Ciphertext + Auth Tag (16 bytes)]
   * @param encryptedBuffer The packed encrypted payload
   * @param key A 32-byte (256-bit) decryption key
   */
  decryptBuffer(encryptedBuffer: Buffer, key: Buffer): Buffer {
    if (key.length !== 32) {
      throw new Error('Invalid KMS key length. AES-256 requires exactly a 32-byte key.');
    }

    if (encryptedBuffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Encrypted payload is too short. Missing IV or Auth Tag.');
    }

    try {
      const iv = encryptedBuffer.subarray(0, IV_LENGTH);
      const authTag = encryptedBuffer.subarray(encryptedBuffer.length - AUTH_TAG_LENGTH);
      const ciphertext = encryptedBuffer.subarray(IV_LENGTH, encryptedBuffer.length - AUTH_TAG_LENGTH);

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error(`KMS Decryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Gets the active KMS key for a user
   */
  async getActiveKey(userId: string): Promise<IKMSKey | null> {
    return await KMSKey.findOne({
      creatorId: userId,
      isActive: true,
      ...unexpiredFilter(new Date()),
    });
  }

  /**
   * Gets all KMS keys for a user
   */
  async getAllKeys(userId: string): Promise<IKMSKey[]> {
    return await KMSKey.find({ creatorId: userId }).sort({ createdAt: -1 });
  }

  /**
   * Generates a key summary report for a user containing counts of active,
   * retired, and expired keys along with asset counts per key version.
   *
   * @param userId MongoDB ObjectId string of the user
   * @param now Optional reference time for expiration evaluation (defaults to new Date())
   * @throws AppError with 400 INVALID_USER_ID if userId is not a valid ObjectId
   */
  async getKeySummary(userId: string, now: Date = new Date()): Promise<KeySummaryReport> {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid or missing userId', StatusCodes.BAD_REQUEST, 'INVALID_USER_ID');
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);

    const [kmsAggregation, assetCounts] = await Promise.all([
      KMSKey.aggregate([
        { $match: { creatorId: userObjectId } },
        {
          $project: {
            keyVersion: 1,
            algorithm: 1,
            isActive: 1,
            expiresAt: 1,
            createdAt: 1,
            status: {
              $cond: {
                if: {
                  $and: [
                    { $ne: ['$expiresAt', null] },
                    { $lte: ['$expiresAt', now] },
                  ],
                },
                then: 'expired',
                else: {
                  $cond: {
                    if: { $eq: ['$isActive', true] },
                    then: 'active',
                    else: 'retired',
                  },
                },
              },
            },
          },
        },
        {
          $facet: {
            counts: [
              {
                $group: {
                  _id: '$status',
                  count: { $sum: 1 },
                },
              },
            ],
            keys: [
              { $sort: { createdAt: -1 } },
            ],
          },
        },
      ]),
      Asset.aggregate([
        {
          $match: {
            creatorId: userObjectId,
            encryptionKeyVersion: { $exists: true, $nin: [null, ''] },
          },
        },
        {
          $group: {
            _id: '$encryptionKeyVersion',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const facet = kmsAggregation[0] || { counts: [], keys: [] };
    const rawCounts: Array<{ _id: string; count: number }> = facet.counts || [];
    const keys: Array<{
      _id: mongoose.Types.ObjectId;
      keyVersion: string;
      algorithm: string;
      isActive: boolean;
      expiresAt?: Date | null;
      createdAt: Date;
      status: 'active' | 'retired' | 'expired';
    }> = facet.keys || [];

    const assetCountMap = new Map<string, number>();
    for (const item of assetCounts) {
      if (item._id) {
        assetCountMap.set(String(item._id), item.count);
      }
    }

    let activeCount = 0;
    let retiredCount = 0;
    let expiredCount = 0;

    for (const item of rawCounts) {
      if (item._id === 'active') activeCount = item.count;
      else if (item._id === 'retired') retiredCount = item.count;
      else if (item._id === 'expired') expiredCount = item.count;
    }

    const totalCount = activeCount + retiredCount + expiredCount;
    const assetsPerVersion: Record<string, number> = {};

    const versions: KeyVersionSummary[] = keys.map((key) => {
      const ver = key.keyVersion;
      const count = assetCountMap.get(ver) ?? 0;
      assetsPerVersion[ver] = count;

      return {
        keyId: key._id.toString(),
        version: ver,
        keyVersion: ver,
        status: key.status,
        algorithm: key.algorithm,
        isActive: key.isActive,
        expiresAt: key.expiresAt ?? null,
        createdAt: key.createdAt,
        assetCount: count,
      };
    });

    for (const [ver, count] of assetCountMap.entries()) {
      if (assetsPerVersion[ver] === undefined) {
        assetsPerVersion[ver] = count;
      }
    }

    return {
      userId,
      active: activeCount,
      retired: retiredCount,
      expired: expiredCount,
      total: totalCount,
      counts: {
        active: activeCount,
        retired: retiredCount,
        expired: expiredCount,
        total: totalCount,
      },
      assetsPerVersion,
      versions,
    };
  }

  /**
   * Deactivates keys whose expiry has passed. Returns the number of keys deactivated.
   */
  async deactivateExpiredKeys(now: Date = new Date()): Promise<number> {
    const result = await KMSKey.updateMany(
      { isActive: true, expiresAt: { $lte: now } },
      { $set: { isActive: false } }
    );
    return result.modifiedCount;
  }

  /**
   * Returns one page of active, unexpired keys created before `cutoff`, in _id
   * order and starting after `afterId`. Pagination by _id keeps the scheduled
   * sweep stable while the keys it rotates are being replaced.
   */
  async findKeysDueForRotation(params: {
    cutoff: Date;
    limit: number;
    afterId?: mongoose.Types.ObjectId;
    now?: Date;
  }): Promise<IKMSKey[]> {
    const { cutoff, limit, afterId, now = new Date() } = params;
    const filter: Record<string, unknown> = {
      isActive: true,
      createdAt: { $lte: cutoff },
      ...unexpiredFilter(now),
    };
    if (afterId) {
      filter._id = { $gt: afterId };
    }

    return await KMSKey.find(filter).sort({ _id: 1 }).limit(limit);
  }

  /**
   * Revokes a KMS key. The state change and its audit row commit together.
   * @param actorId The user performing the revocation, when known.
   */
  async revokeKey(keyId: string, actorId?: string): Promise<IKMSKey> {
    const session = await mongoose.startSession();
    try {
      let revoked: IKMSKey | undefined;
      await session.withTransaction(async () => {
        const key = await KMSKey.findById(keyId).session(session);
        if (!key) throw new Error('KMS key not found');
        if (!key.isActive) throw new Error('KMS key is already inactive');

        key.isActive = false;
        await key.save({ session });
        await kmsAuditService.record(
          {
            action: 'revoke',
            actorId,
            keyId: key._id,
            keyVersion: key.keyVersion,
          },
          session
        );
        revoked = key;
      });
      if (!revoked) throw new Error('KMS key revocation did not complete');
      return revoked;
    } finally {
      session.endSession();
    }
  }

  /**
   * Deactivates keys whose expiry has passed. Returns the number of keys deactivated.
   */
  async deactivateExpiredKeys(now: Date = new Date()): Promise<number> {
    const result = await KMSKey.updateMany(
      { isActive: true, expiresAt: { $lte: now } },
      { $set: { isActive: false } }
    );
    return result.modifiedCount;
  }

  /**
   * Returns one page of active, unexpired keys created before `cutoff`, in _id
   * order and starting after `afterId`. Pagination by _id keeps the scheduled
   * sweep stable while the keys it rotates are being replaced.
   */
  async findKeysDueForRotation(params: {
    cutoff: Date;
    limit: number;
    afterId?: mongoose.Types.ObjectId;
    now?: Date;
  }): Promise<IKMSKey[]> {
    const { cutoff, limit, afterId, now = new Date() } = params;
    const filter: Record<string, unknown> = {
      isActive: true,
      createdAt: { $lte: cutoff },
      ...unexpiredFilter(now),
    };
    if (afterId) {
      filter._id = { $gt: afterId };
    }

    return await KMSKey.find(filter).sort({ _id: 1 }).limit(limit);
  }

  /**
   * Re-wraps every stored symmetric key under the current master key.
   *
   * Keys that already unwrap under the current master are skipped, so the
   * sweep is idempotent and can be re-run after an interruption. Each key is
   * saved on its own: a crash leaves unprocessed keys still readable through
   * MASTER_KEY_PREVIOUS.
   */
  async rewrapKeysToCurrentMaster(batchSize = 100): Promise<KeyRewrapSummary> {
    const { current, previous } = resolveMasterKeys();
    if (!previous) {
      throw new AppError(
        'MASTER_KEY_PREVIOUS must be set to re-wrap KMS keys',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'KMS_PREVIOUS_MASTER_KEY_MISSING'
      );
    }

    const summary: KeyRewrapSummary = { scanned: 0, rewrapped: 0, alreadyCurrent: 0, failed: [] };
    let afterId: mongoose.Types.ObjectId | undefined;
    let batch: IKMSKey[];

    do {
      batch = await KMSKey.find(afterId ? { _id: { $gt: afterId } } : {})
        .sort({ _id: 1 })
        .limit(batchSize);

      for (const key of batch) {
        summary.scanned += 1;

        if (this.tryUnwrapWithMaster(key, current) !== null) {
          summary.alreadyCurrent += 1;
          continue;
        }

        const symmetricKey = this.tryUnwrapWithMaster(key, previous);
        if (!symmetricKey) {
          summary.failed.push(key.id);
          continue;
        }

        try {
          const wrapped = this.wrapSymmetricKey(symmetricKey, current);
          key.encryptedKeyValue = wrapped.encrypted;
          key.iv = wrapped.iv;
          key.authTag = wrapped.authTag;
          await key.save();
          summary.rewrapped += 1;
        } catch {
          summary.failed.push(key.id);
        }
      }

      afterId = batch[batch.length - 1]?._id;
    } while (batch.length === batchSize);

    return summary;
  }

  /**
   * Re-keys every encrypted asset owned by `userId` under one new data key.
   *
   * Each asset keeps its own data key, referenced by its SPVRecord. For every
   * asset the service unwraps that key with KMS_MASTER_KEY, downloads the
   * stored blob, decrypts it, re-encrypts it under the new key and uploads the
   * result to the same provider. All database writes (asset references and
   * versions, the new KMSKey, deactivation of previous keys and the SPVRecord
   * key pointers) are committed in a single transaction.
   *
   * Storage writes cannot join the transaction, so they are ordered around it:
   * new blobs are destroyed again if the transaction fails, and replaced blobs
   * are destroyed only after the commit succeeds.
   *
   * @throws {Error} when the user has no active key, an asset has no resolvable
   *   key, or any blob cannot be re-encrypted. Nothing is changed in that case.
   */
  async rotateKey(userId: string): Promise<RotateKeyResult> {
    const session = await mongoose.startSession();
    const blobs: BlobTracker = { uploaded: [], replaced: [] };
    let committing = false;
    let result: RotateKeyResult;

    try {
      session.startTransaction();
      result = await this.applyRotation(session, userId, blobs);
      committing = true;
      await session.commitTransaction();
    } catch (error) {
      if (committing) {
        // The commit outcome is unknown, so the database may already point at
        // the new blobs. Keep them and log them for reconciliation.
        logger.error('KMS rotation commit failed; new blobs retained for reconciliation', {
          userId,
          uploaded: blobs.uploaded,
        });
      } else {
        if (session.inTransaction()) await session.abortTransaction();
        await this.destroyBlobs(blobs.uploaded);
      }
      throw error;
    } finally {
      await session.endSession();
    }

    await this.destroyBlobs(blobs.replaced);
    void webhookService.enqueueForOwner(
      userId,
      createWebhookEvent(VerificationWebhookEvent.KMS_KEY_ROTATED, {
        keyVersion: result.newKeyVersion,
        previousKeyVersion: result.oldKeyVersion,
        assetsReEncrypted: result.assetsReEncrypted,
      })
    ).catch((error: unknown) => {
      logger.error('Failed to enqueue KMS rotation webhook', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return result;
  }

  /**
   * Performs the database and storage work of a rotation inside an open
   * transaction. It does not commit; the caller owns the transaction.
   */
  private async applyRotation(
    session: mongoose.ClientSession,
    userId: string,
    blobs: BlobTracker
  ): Promise<RotateKeyResult> {
    const activeKeys = await KMSKey.find({ creatorId: userId, isActive: true }).session(session);
    if (activeKeys.length === 0) throw new Error('No active KMS key found for user');

    const allKeys = await KMSKey.find({ creatorId: userId }).select('keyVersion').session(session);
    const oldKeyVersion = `v${Math.max(...activeKeys.map((key: any) => parseKeyVersion(key.keyVersion)))}`;
    const newKeyVersion = `v${Math.max(...allKeys.map((key: any) => parseKeyVersion(key.keyVersion))) + 1}`;

    const newDataKey = this.generateSymmetricKey();

    const assets = await Asset.find({
      creatorId: userId,
      isEncrypted: true,
      encryptionKeyVersion: { $ne: newKeyVersion },
    }).session(session);

    const reEncryptedAssetIds: mongoose.Types.ObjectId[] = [];

    for (const asset of assets) {
      const spvRecord = await SPVRecordModel.findOne({ assetId: asset._id }).session(session);
      if (!spvRecord) {
        throw new Error(`Asset ${asset._id} has no SPV record that references its key`);
      }

      const currentKey = await KMSKey.findById(spvRecord.kmsKeyId).session(session);
      if (!currentKey) {
        throw new Error(`KMS key ${spvRecord.kmsKeyId} for asset ${asset._id} was not found`);
      }

      let newRef: StorageRef;
      try {
        newRef = await this.reencryptStoredBlob(
          asset,
          userId,
          this.unwrapDataKey(currentKey),
          newDataKey
        );
      } catch (error) {
        throw new Error(`Failed to re-encrypt asset ${asset._id}: ${(error as Error).message}`);
      }

      blobs.uploaded.push(newRef);
      blobs.replaced.push({ provider: asset.storageProvider as StorageRef['provider'], reference: asset.storageReferenceId });

      asset.storageReferenceId = newRef.reference;
      asset.encryptionKeyVersion = newKeyVersion;
      await asset.save({ session });
      reEncryptedAssetIds.push(asset._id);
    }

    const wrapped = this.wrapDataKey(newDataKey);
    const newKey = new KMSKey({
      creatorId: userId,
      keyVersion: newKeyVersion,
      algorithm: ALGORITHM.toUpperCase(),
      encryptedKeyValue: wrapped.encryptedKeyValue,
      iv: wrapped.iv,
      authTag: wrapped.authTag,
      isActive: true,
    });
    await newKey.save({ session });

    await KMSKey.updateMany(
      { creatorId: userId, isActive: true, _id: { $ne: newKey._id } },
      { $set: { isActive: false } }
    ).session(session);

    if (reEncryptedAssetIds.length > 0) {
      await SPVRecordModel.updateMany(
        { assetId: { $in: reEncryptedAssetIds } },
        { $set: { kmsKeyId: newKey._id } }
      ).session(session);
    }

    return {
      oldKeyVersion,
      newKeyVersion,
      assetsReEncrypted: reEncryptedAssetIds.length,
    };
  }

  /**
   * Fetches an asset's stored blob, re-encrypts it from `fromKey` to `toKey`
   * and uploads the result to the same provider.
   */
  private async reencryptStoredBlob(
    asset: IAsset,
    userId: string,
    fromKey: Buffer,
    toKey: Buffer
  ): Promise<StorageRef> {
    const provider = asset.storageProvider;
    if (provider !== 'cloudinary' && provider !== 'ipfs') {
      throw new Error(`Storage provider ${provider} not supported for rotation`);
    }

    const blob = await this.fetchStoredBlob(provider, asset.storageReferenceId);
    const plaintext = this.decryptAssetPayload(blob, fromKey);
    const encrypted = this.encryptAssetPayload(plaintext, toKey);

    if (provider === 'cloudinary') {
      const publicId = `stellarproof/spv/${userId}/${crypto.randomUUID()}`;
      const uploaded = await this.uploadRawToCloudinary(encrypted, publicId);
      return { provider, reference: uploaded.public_id };
    }

    const uploaded = await ipfsService.upload({ content: encrypted, name: asset.fileName });
    return { provider, reference: uploaded.cid };
  }

  private async fetchStoredBlob(
    provider: StorageRef['provider'],
    reference: string
  ): Promise<Buffer> {
    let url: string;
    if (provider === 'cloudinary') {
      url = cloudinary.url(reference, { resource_type: 'raw', secure: true });
    } else {
      const gateway = process.env.PINATA_GATEWAY_URL;
      if (!gateway) throw new Error('PINATA_GATEWAY_URL is not configured');
      url = `${gateway.replace(/\/$/, '')}/${reference}`;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch blob from ${provider}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Decrypts an asset blob in the layout written by SPV uploads:
   * [authTag (16 bytes) | IV (12 bytes) | ciphertext].
   */
  private decryptAssetPayload(blob: Buffer, key: Buffer): Buffer {
    if (blob.length < AUTH_TAG_LENGTH + IV_LENGTH) {
      throw new Error('Encrypted payload is too short. Missing auth tag or IV.');
    }

    const authTag = blob.subarray(0, AUTH_TAG_LENGTH);
    const iv = blob.subarray(AUTH_TAG_LENGTH, AUTH_TAG_LENGTH + IV_LENGTH);
    const ciphertext = blob.subarray(AUTH_TAG_LENGTH + IV_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Encrypts an asset blob in the SPV upload layout: [authTag | IV | ciphertext]. */
  private encryptAssetPayload(plaintext: Buffer, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([cipher.getAuthTag(), iv, ciphertext]);
  }

  /** Reads KMS_MASTER_KEY (64 hex characters) used to wrap per-asset data keys. */
  private resolveWrappingKey(): Buffer {
    const hex = process.env.KMS_MASTER_KEY ?? process.env.MASTER_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('KMS_MASTER_KEY must be a 64-character hex string (32 bytes for AES-256)');
    }
    return Buffer.from(hex, 'hex');
  }

  /**
   * Wraps a data key with KMS_MASTER_KEY, producing the fields stored on a
   * KMSKey document. Mirrors the layout written by SPV uploads.
   */
  private wrapDataKey(dataKey: Buffer): { encryptedKeyValue: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.resolveWrappingKey(), iv);
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);

    return {
      encryptedKeyValue: wrapped.toString('base64'),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    };
  }

  /**
   * Unwraps the data key stored on a KMSKey document. Keys in any other
   * format (for example, the legacy hex format) are rejected explicitly.
   */
  private unwrapDataKey(kmsKey: IKMSKey): Buffer {
    const wrapped = Buffer.from(kmsKey.encryptedKeyValue, 'base64');
    const iv = Buffer.from(kmsKey.iv, 'hex');
    const authTag = Buffer.from(kmsKey.authTag, 'hex');

    if (
      wrapped.length !== DATA_KEY_LENGTH ||
      iv.length !== IV_LENGTH ||
      authTag.length !== AUTH_TAG_LENGTH
    ) {
      throw new Error(`KMS key ${(kmsKey as any)._id} is not in a supported wrapping format`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, this.resolveWrappingKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  }

  /**
   * Encrypts a symmetric key using the given master key (Hex output for DB storage)
   */
  private wrapSymmetricKey(symmetricKey: Buffer, masterKey: Buffer): WrappedKey {
    const iv = crypto.randomBytes(16); // 16 bytes for hex storage format
    const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

    let encrypted = cipher.update(symmetricKey.toString('hex'), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  /**
   * Attempts to unwrap a stored symmetric key with one master key.
   * Returns null when the GCM auth tag does not verify under that key.
   */
  private tryUnwrapWithMaster(record: WrappedKeyRecord, masterKey: Buffer): Buffer | null {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, Buffer.from(record.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));

      let decryptedHex = decipher.update(record.encryptedKeyValue, 'hex', 'utf8');
      decryptedHex += decipher.final('utf8');
      return Buffer.from(decryptedHex, 'hex');
    } catch {
      return null;
    }
  }

  private uploadRawToCloudinary(buffer: Buffer, publicId: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, overwrite: false },
        (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            reject(error ?? new Error('Cloudinary upload_stream returned no result'));
            return;
          }
          resolve(result);
        }
      );

      Readable.from(buffer).pipe(uploadStream);
    });
  }

  /**
   * Deletes replaced or orphaned Cloudinary blobs. Failures are logged rather
   * than thrown: the database state is already final at this point.
   * IPFS content is not deleted here; it stays pinned until unpinned separately.
   */
  private async destroyBlobs(refs: StorageRef[]): Promise<void> {
    for (const ref of refs) {
      if (ref.provider !== 'cloudinary') continue;
      try {
        await cloudinary.uploader.destroy(ref.reference, { resource_type: 'raw' });
      } catch (error) {
        logger.warn('Failed to delete blob during KMS rotation', {
          provider: ref.provider,
          reference: ref.reference,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const kmsService = new KmsService();
