/**
 * Developer Job Service Tests
 *
 * Tests cover:
 * - List jobs with pagination, filtering, sorting
 * - Get single job by ID with ownership validation
 * - Usage summary with status aggregation
 * - Ownership scoping (developer A doesn't see developer B's jobs)
 * - Error handling and validation
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

import { developerJobService } from '../developerJob.service';
import { VerificationJobModel } from '../../models/verificationJob.model';
import { VerificationStatus } from '../../types/verification.types';
import { AppError } from '../../errors/AppError';
import type { ValidatedListJobsQuery, ValidatedUsageSummaryQuery } from '../../types/developer.types';

let mongoServer: MongoMemoryServer;

const hex = (bytes: number): string => crypto.randomBytes(bytes).toString('hex');

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await VerificationJobModel.deleteMany({});
});

describe('DeveloperJobService', () => {
  describe('listJobs', () => {
    it('should return empty list when no jobs exist', async () => {
      const devKey = Keypair.random().publicKey();
      const query: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 20,
      };

      const result = await developerJobService.listJobs('dev-id', devKey, query);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(0);
    });

    it('should return jobs owned by the developer only', async () => {
      const devKey1 = Keypair.random().publicKey();
      const devKey2 = Keypair.random().publicKey();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey1, contentHash: hex(32), status: VerificationStatus.COMPLETED },
        { ownerPublicKey: devKey1, contentHash: hex(32), status: VerificationStatus.PENDING },
        { ownerPublicKey: devKey2, contentHash: hex(32), status: VerificationStatus.COMPLETED },
      ]);

      const query: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 20,
      };

      const result = await developerJobService.listJobs('dev-id-1', devKey1, query);

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items.every((j) => j.ownerPublicKey === devKey1)).toBe(true);
    });

    it('should filter jobs by status', async () => {
      const devKey = Keypair.random().publicKey();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.FAILED },
      ]);

      const query: ValidatedListJobsQuery = {
        status: VerificationStatus.COMPLETED,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 20,
      };

      const result = await developerJobService.listJobs('dev-id', devKey, query);

      expect(result.total).toBe(1);
      expect(result.items[0].status).toBe(VerificationStatus.COMPLETED);
    });

    it('should filter jobs by date range', async () => {
      const devKey = Keypair.random().publicKey();
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING, createdAt: yesterday },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING, createdAt: now },
      ]);

      const query: ValidatedListJobsQuery = {
        createdFrom: now,
        createdTo: tomorrow,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 20,
      };

      const result = await developerJobService.listJobs('dev-id', devKey, query);

      expect(result.total).toBe(1);
      expect(result.items[0].createdAt >= now).toBe(true);
    });

    it('should sort jobs in ascending order', async () => {
      const devKey = Keypair.random().publicKey();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED },
      ]);

      const query: ValidatedListJobsQuery = {
        sortBy: 'status',
        sortOrder: 'asc',
        page: 1,
        limit: 20,
      };

      const result = await developerJobService.listJobs('dev-id', devKey, query);

      expect(result.items[0].status).toBe(VerificationStatus.COMPLETED);
      expect(result.items[1].status).toBe(VerificationStatus.PENDING);
    });

    it('should paginate results correctly', async () => {
      const devKey = Keypair.random().publicKey();

      const jobs = Array.from({ length: 50 }, () => ({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.PENDING,
      }));
      await VerificationJobModel.insertMany(jobs);

      const query1: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 20,
      };

      const result1 = await developerJobService.listJobs('dev-id', devKey, query1);

      expect(result1.total).toBe(50);
      expect(result1.items).toHaveLength(20);
      expect(result1.totalPages).toBe(3);

      const query2: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 2,
        limit: 20,
      };

      const result2 = await developerJobService.listJobs('dev-id', devKey, query2);

      expect(result2.items).toHaveLength(20);
      expect(result2.items[0]._id).not.toBe(result1.items[0]._id);
    });

    it('should respect max limit cap', async () => {
      const devKey = Keypair.random().publicKey();

      const jobs = Array.from({ length: 250 }, () => ({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.PENDING,
      }));
      await VerificationJobModel.insertMany(jobs);

      const query: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 1,
        limit: 500, // exceeds max
      };

      const result = await developerJobService.listJobs('dev-id', devKey, query);

      expect(result.limit).toBeLessThanOrEqual(200);
    });

    it('should throw error for invalid page', async () => {
      const devKey = Keypair.random().publicKey();
      const query: ValidatedListJobsQuery = {
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: 0,
        limit: 20,
      };

      await expect(developerJobService.listJobs('dev-id', devKey, query)).rejects.toThrow(AppError);
    });
  });

  describe('getJobById', () => {
    it('should return job by ID if owned by developer', async () => {
      const devKey = Keypair.random().publicKey();
      const job = await VerificationJobModel.create({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.COMPLETED,
      });

      const result = await developerJobService.getJobById('dev-id', devKey, job._id.toString());

      expect(result._id.toString()).toBe(job._id.toString());
      expect(result.ownerPublicKey).toBe(devKey);
    });

    it('should throw 404 if job not owned by developer', async () => {
      const devKey1 = Keypair.random().publicKey();
      const devKey2 = Keypair.random().publicKey();

      const job = await VerificationJobModel.create({
        ownerPublicKey: devKey1,
        contentHash: hex(32),
        status: VerificationStatus.COMPLETED,
      });

      await expect(
        developerJobService.getJobById('dev-id-2', devKey2, job._id.toString())
      ).rejects.toThrow(new RegExp('Job not found', 'i'));
    });

    it('should throw 400 for malformed job ID', async () => {
      const devKey = Keypair.random().publicKey();

      await expect(
        developerJobService.getJobById('dev-id', devKey, 'invalid-id')
      ).rejects.toThrow(new RegExp('Invalid job ID format', 'i'));
    });

    it('should throw 404 for non-existent job', async () => {
      const devKey = Keypair.random().publicKey();
      const validId = new mongoose.Types.ObjectId().toString();

      await expect(
        developerJobService.getJobById('dev-id', devKey, validId)
      ).rejects.toThrow(new RegExp('Job not found', 'i'));
    });
  });

  describe('getUsageSummary', () => {
    it('should return zero counts for empty period', async () => {
      const devKey = Keypair.random().publicKey();
      const from = new Date();
      const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

      const query: ValidatedUsageSummaryQuery = { from, to };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.totalJobs).toBe(0);
      expect(result.statusCounts.queued).toBe(0);
      expect(result.statusCounts.running).toBe(0);
      expect(result.statusCounts.succeeded).toBe(0);
      expect(result.statusCounts.failed).toBe(0);
      expect(result.successRate).toBe(0);
    });

    it('should count jobs by normalized status', async () => {
      const devKey = Keypair.random().publicKey();
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PROCESSING, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.FAILED, createdAt: now },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.totalJobs).toBe(4);
      expect(result.statusCounts.running).toBe(2); // PENDING + PROCESSING
      expect(result.statusCounts.succeeded).toBe(1);
      expect(result.statusCounts.failed).toBe(1);
    });

    it('should calculate success rate correctly', async () => {
      const devKey = Keypair.random().publicKey();
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.FAILED, createdAt: now },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.successRate).toBe(66.67); // 2/3
    });

    it('should return zero success rate when no terminal jobs', async () => {
      const devKey = Keypair.random().publicKey();
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PROCESSING, createdAt: now },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.successRate).toBe(0);
    });

    it('should respect date range boundaries', async () => {
      const devKey = Keypair.random().publicKey();
      const start = new Date('2024-01-01');
      const middle = new Date('2024-01-15');
      const end = new Date('2024-02-01');

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: start },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: middle },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: end },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date('2024-01-01'),
        to: new Date('2024-01-31'),
      };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.totalJobs).toBe(2); // only start and middle
    });

    it('should throw error for invalid date range', async () => {
      const devKey = Keypair.random().publicKey();
      const from = new Date();
      const to = new Date(from.getTime() - 1000);

      const query: ValidatedUsageSummaryQuery = { from, to };

      await expect(developerJobService.getUsageSummary('dev-id', devKey, query)).rejects.toThrow(AppError);
    });

    it('should throw error for date range exceeding max days', async () => {
      const devKey = Keypair.random().publicKey();
      const from = new Date();
      const to = new Date(from.getTime() + 400 * 24 * 60 * 60 * 1000);

      const query: ValidatedUsageSummaryQuery = { from, to };

      await expect(developerJobService.getUsageSummary('dev-id', devKey, query)).rejects.toThrow(AppError);
    });

    it('should include per-app breakdown', async () => {
      const devKey = Keypair.random().publicKey();
      const appId1 = new mongoose.Types.ObjectId();
      const appId2 = new mongoose.Types.ObjectId();
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, assetId: appId1, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, assetId: appId1, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, assetId: appId2, contentHash: hex(32), status: VerificationStatus.FAILED, createdAt: now },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };

      const result = await developerJobService.getUsageSummary('dev-id', devKey, query);

      expect(result.apps).toHaveLength(2);
      expect(result.apps[0].jobCount).toBe(2);
      expect(result.apps[1].jobCount).toBe(1);
    });

    it('should not see other developers jobs in summary', async () => {
      const devKey1 = Keypair.random().publicKey();
      const devKey2 = Keypair.random().publicKey();
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey1, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey1, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey2, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
      ]);

      const query: ValidatedUsageSummaryQuery = {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };

      const result = await developerJobService.getUsageSummary('dev-id-1', devKey1, query);

      expect(result.totalJobs).toBe(2);
      expect(result.statusCounts.succeeded).toBe(2);
    });
  });
});
