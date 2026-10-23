import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { kmsService, KeySummaryReport } from '../services/kms.service';
import { getKeySummary } from '../controllers/kms.controller';
import kmsRoutes from '../routes/kms.routes';
import KMSKey from '../models/KMSKey.model';
import Asset from '../models/Asset.model';
import { AppError } from '../errors/AppError';
import { globalErrorHandler } from '../middlewares/errorHandler';

describe('KMS Key Versioning Summary Report (#754)', () => {
  const validUserId = new mongoose.Types.ObjectId().toHexString();
  const validUserObjectId = new mongoose.Types.ObjectId(validUserId);
  const now = new Date('2026-10-21T12:00:00.000Z');

  let kmsAggregateSpy: jest.SpyInstance;
  let assetAggregateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    kmsAggregateSpy = jest.spyOn(KMSKey, 'aggregate');
    assetAggregateSpy = jest.spyOn(Asset, 'aggregate');
  });

  afterEach(() => {
    kmsAggregateSpy.mockRestore();
    assetAggregateSpy.mockRestore();
  });

  describe('Service: kmsService.getKeySummary', () => {
    it('throws AppError 400 INVALID_USER_ID if userId is missing or empty', async () => {
      await expect(kmsService.getKeySummary('')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_USER_ID',
      });
      expect(kmsAggregateSpy).not.toHaveBeenCalled();
      expect(assetAggregateSpy).not.toHaveBeenCalled();
    });

    it('throws AppError 400 INVALID_USER_ID if userId is not a valid ObjectId', async () => {
      await expect(kmsService.getKeySummary('invalid-user-id')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_USER_ID',
      });
      expect(kmsAggregateSpy).not.toHaveBeenCalled();
      expect(assetAggregateSpy).not.toHaveBeenCalled();
    });

    it('returns zero counts, empty assetsPerVersion, and empty versions for a user with no keys and no assets', async () => {
      kmsAggregateSpy.mockResolvedValue([
        {
          counts: [],
          keys: [],
        },
      ]);
      assetAggregateSpy.mockResolvedValue([]);

      const report: KeySummaryReport = await kmsService.getKeySummary(validUserId, now);

      expect(report).toEqual({
        userId: validUserId,
        active: 0,
        retired: 0,
        expired: 0,
        total: 0,
        counts: {
          active: 0,
          retired: 0,
          expired: 0,
          total: 0,
        },
        assetsPerVersion: {},
        versions: [],
      });
    });

    it('correctly aggregates active, retired, and expired keys along with asset counts per version', async () => {
      const activeKeyId = new mongoose.Types.ObjectId();
      const retiredKeyId = new mongoose.Types.ObjectId();
      const expiredKeyId = new mongoose.Types.ObjectId();

      kmsAggregateSpy.mockResolvedValue([
        {
          counts: [
            { _id: 'active', count: 1 },
            { _id: 'retired', count: 1 },
            { _id: 'expired', count: 1 },
          ],
          keys: [
            {
              _id: activeKeyId,
              keyVersion: 'v3',
              algorithm: 'AES-256-GCM',
              isActive: true,
              expiresAt: null,
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              status: 'active',
            },
            {
              _id: retiredKeyId,
              keyVersion: 'v2',
              algorithm: 'AES-256-GCM',
              isActive: false,
              expiresAt: null,
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              status: 'retired',
            },
            {
              _id: expiredKeyId,
              keyVersion: 'v1',
              algorithm: 'AES-256-GCM',
              isActive: false,
              expiresAt: new Date('2026-01-15T00:00:00.000Z'),
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              status: 'expired',
            },
          ],
        },
      ]);

      assetAggregateSpy.mockResolvedValue([
        { _id: 'v3', count: 15 },
        { _id: 'v2', count: 8 },
        // v1 has 0 assets (not returned in aggregation)
      ]);

      const report = await kmsService.getKeySummary(validUserId, now);

      expect(report.userId).toBe(validUserId);
      expect(report.active).toBe(1);
      expect(report.retired).toBe(1);
      expect(report.expired).toBe(1);
      expect(report.total).toBe(3);
      expect(report.counts).toEqual({
        active: 1,
        retired: 1,
        expired: 1,
        total: 3,
      });

      // Assets per version
      expect(report.assetsPerVersion).toEqual({
        v3: 15,
        v2: 8,
        v1: 0, // Unreferenced key version gets 0
      });

      // Versions list
      expect(report.versions).toHaveLength(3);
      expect(report.versions[0]).toEqual({
        keyId: activeKeyId.toString(),
        version: 'v3',
        keyVersion: 'v3',
        status: 'active',
        algorithm: 'AES-256-GCM',
        isActive: true,
        expiresAt: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        assetCount: 15,
      });
      expect(report.versions[1]).toEqual({
        keyId: retiredKeyId.toString(),
        version: 'v2',
        keyVersion: 'v2',
        status: 'retired',
        algorithm: 'AES-256-GCM',
        isActive: false,
        expiresAt: null,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        assetCount: 8,
      });
      expect(report.versions[2]).toEqual({
        keyId: expiredKeyId.toString(),
        version: 'v1',
        keyVersion: 'v1',
        status: 'expired',
        algorithm: 'AES-256-GCM',
        isActive: false,
        expiresAt: new Date('2026-01-15T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        assetCount: 0,
      });
    });

    it('includes legacy asset versions in assetsPerVersion even if no corresponding KMSKey document exists', async () => {
      kmsAggregateSpy.mockResolvedValue([
        {
          counts: [{ _id: 'active', count: 1 }],
          keys: [
            {
              _id: new mongoose.Types.ObjectId(),
              keyVersion: 'v2',
              algorithm: 'AES-256-GCM',
              isActive: true,
              expiresAt: null,
              createdAt: new Date(),
              status: 'active',
            },
          ],
        },
      ]);

      assetAggregateSpy.mockResolvedValue([
        { _id: 'v2', count: 10 },
        { _id: 'legacy-v0', count: 4 },
      ]);

      const report = await kmsService.getKeySummary(validUserId, now);

      expect(report.assetsPerVersion['v2']).toBe(10);
      expect(report.assetsPerVersion['legacy-v0']).toBe(4);
    });

    it('verifies that the MongoDB aggregation pipeline properly structures status conditional expressions', async () => {
      kmsAggregateSpy.mockResolvedValue([{ counts: [], keys: [] }]);
      assetAggregateSpy.mockResolvedValue([]);

      await kmsService.getKeySummary(validUserId, now);

      expect(kmsAggregateSpy).toHaveBeenCalledTimes(1);
      const kmsPipeline = kmsAggregateSpy.mock.calls[0][0];

      // Stage 0: $match creatorId
      expect(kmsPipeline[0]).toEqual({
        $match: { creatorId: expect.any(mongoose.Types.ObjectId) },
      });
      expect(kmsPipeline[0].$match.creatorId.toString()).toBe(validUserId);

      // Stage 1: $project with conditional status
      expect(kmsPipeline[1].$project).toBeDefined();
      expect(kmsPipeline[1].$project.status).toBeDefined();

      // Stage 2: $facet with counts and keys
      expect(kmsPipeline[2].$facet).toBeDefined();
      expect(kmsPipeline[2].$facet.counts).toBeDefined();
      expect(kmsPipeline[2].$facet.keys).toBeDefined();

      // Asset pipeline
      expect(assetAggregateSpy).toHaveBeenCalledTimes(1);
      const assetPipeline = assetAggregateSpy.mock.calls[0][0];
      expect(assetPipeline[0]).toEqual({
        $match: {
          creatorId: expect.any(mongoose.Types.ObjectId),
          encryptionKeyVersion: { $exists: true, $nin: [null, ''] },
        },
      });
      expect(assetPipeline[1]).toEqual({
        $group: {
          _id: '$encryptionKeyVersion',
          count: { $sum: 1 },
        },
      });
    });
  });

  describe('Controller: getKeySummary', () => {
    it('returns 200 with success: true and data when service succeeds', async () => {
      const mockSummary: KeySummaryReport = {
        userId: validUserId,
        active: 1,
        retired: 0,
        expired: 0,
        total: 1,
        counts: { active: 1, retired: 0, expired: 0, total: 1 },
        assetsPerVersion: { v1: 2 },
        versions: [],
      };

      const getKeySummarySpy = jest.spyOn(kmsService, 'getKeySummary').mockResolvedValue(mockSummary);

      const req = { params: { userId: validUserId } } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getKeySummary(req, res, next);

      expect(getKeySummarySpy).toHaveBeenCalledWith(validUserId);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: mockSummary });
      expect(next).not.toHaveBeenCalled();

      getKeySummarySpy.mockRestore();
    });

    it('passes error to next middleware when next is provided', async () => {
      const error = new AppError('Invalid or missing userId', 400, 'INVALID_USER_ID');
      const getKeySummarySpy = jest.spyOn(kmsService, 'getKeySummary').mockRejectedValue(error);

      const req = { params: { userId: 'bad-id' } } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getKeySummary(req, res, next);

      expect(next).toHaveBeenCalledWith(error);

      getKeySummarySpy.mockRestore();
    });

    it('falls back to responding with status code when next is omitted', async () => {
      const error = new AppError('Invalid or missing userId', 400, 'INVALID_USER_ID');
      const getKeySummarySpy = jest.spyOn(kmsService, 'getKeySummary').mockRejectedValue(error);

      const req = { params: { userId: 'bad-id' } } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await getKeySummary(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or missing userId',
        code: 'INVALID_USER_ID',
      });

      getKeySummarySpy.mockRestore();
    });
  });

  describe('Integration / Routes: GET /api/v1/kms/keys/:userId/summary', () => {
    let app: express.Express;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use('/api/v1/kms', kmsRoutes);
      app.use(globalErrorHandler);
    });

    it('returns 400 INVALID_USER_ID when userId is not a valid ObjectId', async () => {
      const res = await request(app).get('/api/v1/kms/keys/invalid-mongo-id/summary');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: 'Invalid or missing userId',
        code: 'INVALID_USER_ID',
      });
    });

    it('returns 200 with complete key version report for a valid user', async () => {
      kmsAggregateSpy.mockResolvedValue([
        {
          counts: [
            { _id: 'active', count: 1 },
            { _id: 'retired', count: 2 },
          ],
          keys: [
            {
              _id: new mongoose.Types.ObjectId(),
              keyVersion: 'v3',
              algorithm: 'AES-256-GCM',
              isActive: true,
              expiresAt: null,
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              status: 'active',
            },
            {
              _id: new mongoose.Types.ObjectId(),
              keyVersion: 'v2',
              algorithm: 'AES-256-GCM',
              isActive: false,
              expiresAt: null,
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              status: 'retired',
            },
            {
              _id: new mongoose.Types.ObjectId(),
              keyVersion: 'v1',
              algorithm: 'AES-256-GCM',
              isActive: false,
              expiresAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              status: 'retired',
            },
          ],
        },
      ]);

      assetAggregateSpy.mockResolvedValue([
        { _id: 'v3', count: 20 },
        { _id: 'v2', count: 5 },
      ]);

      const res = await request(app).get(`/api/v1/kms/keys/${validUserId}/summary`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();

      const { data } = res.body;
      expect(data.userId).toBe(validUserId);
      expect(data.active).toBe(1);
      expect(data.retired).toBe(2);
      expect(data.expired).toBe(0);
      expect(data.total).toBe(3);
      expect(data.counts).toEqual({
        active: 1,
        retired: 2,
        expired: 0,
        total: 3,
      });
      expect(data.assetsPerVersion).toEqual({
        v3: 20,
        v2: 5,
        v1: 0,
      });
      expect(data.versions).toHaveLength(3);
      expect(data.versions[0].version).toBe('v3');
      expect(data.versions[0].assetCount).toBe(20);
      expect(data.versions[1].version).toBe('v2');
      expect(data.versions[1].assetCount).toBe(5);
      expect(data.versions[2].version).toBe('v1');
      expect(data.versions[2].assetCount).toBe(0);
    });
  });
});
