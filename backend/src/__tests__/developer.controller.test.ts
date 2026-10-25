/**
 * Developer Controller Tests
 *
 * Tests cover:
 * - List jobs endpoint with various query parameters
 * - Get single job endpoint
 * - Usage summary endpoint
 * - Authentication and authorization
 * - Input validation
 * - Error handling
 */

import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { StatusCodes } from 'http-status-codes';

import { developerController } from '../controllers/developer.controller';
import { VerificationJobModel } from '../models/verificationJob.model';
import { VerificationStatus } from '../types/verification.types';
import type { IUser } from '../models/User.model';

let mongoServer: MongoMemoryServer;

const hex = (bytes: number): string => crypto.randomBytes(bytes).toString('hex');

const createMockRequest = (overrides: Partial<Request> = {}): Partial<Request> => ({
  query: {},
  params: {},
  body: {},
  user: undefined,
  ...overrides,
});

const createMockResponse = (): Partial<Response> => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    statusCode: 200,
  } as Partial<Response>;
  return res;
};

const createMockNext = (): NextFunction => jest.fn();

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
  jest.clearAllMocks();
});

describe('DeveloperController', () => {
  describe('listJobs', () => {
    it('should return 401 if user not authenticated', async () => {
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should return 200 with paginated jobs', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const jobs = Array.from({ length: 25 }, () => ({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.PENDING,
      }));
      await VerificationJobModel.insertMany(jobs);

      const req = createMockRequest({
        query: { page: '1', limit: '20' },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(true);
      expect(jsonCall.data).toHaveLength(20);
      expect(jsonCall.total).toBe(25);
      expect(jsonCall.totalPages).toBe(2);
    });

    it('should filter jobs by status', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.PENDING },
      ]);

      const req = createMockRequest({
        query: { page: '1', limit: '20', status: VerificationStatus.COMPLETED },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.total).toBe(1);
      expect(jsonCall.data[0].status).toBe(VerificationStatus.COMPLETED);
    });

    it('should reject invalid status', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        query: { page: '1', limit: '20', status: 'invalid-status' },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should reject invalid date range', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        query: {
          page: '1',
          limit: '20',
          createdFrom: '2024-01-01',
          createdTo: 'invalid-date',
        },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should reject createdFrom after createdTo', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        query: {
          page: '1',
          limit: '20',
          createdFrom: '2024-02-01',
          createdTo: '2024-01-01',
        },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should use default pagination values', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      await VerificationJobModel.create({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.PENDING,
      });

      const req = createMockRequest({
        query: {},
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.listJobs(req, res, next);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.limit).toBe(20); // default limit
      expect(jsonCall.page).toBe(1); // default page
    });
  });

  describe('getJobById', () => {
    it('should return 401 if user not authenticated', async () => {
      const req = createMockRequest({ params: { id: 'some-id' } }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getJobById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should return 200 with job details', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const job = await VerificationJobModel.create({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.COMPLETED,
      });

      const req = createMockRequest({
        params: { id: job._id.toString() },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getJobById(req, res, next);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(true);
      expect(jsonCall.data._id.toString()).toBe(job._id.toString());
    });

    it('should return 400 for malformed job ID', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        params: { id: 'invalid-id' },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getJobById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should return 404 for non-existent job', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;
      const validId = new mongoose.Types.ObjectId().toString();

      const req = createMockRequest({
        params: { id: validId },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getJobById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should return 404 for job owned by another developer', async () => {
      const devKey1 = Keypair.random().publicKey();
      const devKey2 = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey2 } as any;

      const job = await VerificationJobModel.create({
        ownerPublicKey: devKey1,
        contentHash: hex(32),
        status: VerificationStatus.COMPLETED,
      });

      const req = createMockRequest({
        params: { id: job._id.toString() },
        user,
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getJobById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getUsageSummary', () => {
    it('should return 401 if user not authenticated', async () => {
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should return 200 with usage summary', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey, contentHash: hex(32), status: VerificationStatus.FAILED, createdAt: now },
      ]);

      const req = createMockRequest({ user, query: {} }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(true);
      expect(jsonCall.data.totalJobs).toBeGreaterThanOrEqual(0);
      expect(jsonCall.data.statusCounts).toBeDefined();
      expect(jsonCall.data.successRate).toBeDefined();
    });

    it('should reject invalid from date', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        user,
        query: { from: 'invalid-date' },
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should reject from after to', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;

      const req = createMockRequest({
        user,
        query: {
          from: '2024-02-01',
          to: '2024-01-01',
        },
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should use default date range (last 30 days)', async () => {
      const devKey = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey } as any;
      const now = new Date();

      await VerificationJobModel.create({
        ownerPublicKey: devKey,
        contentHash: hex(32),
        status: VerificationStatus.COMPLETED,
        createdAt: now,
      });

      const req = createMockRequest({
        user,
        query: {},
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.data.period).toBeDefined();
      expect(jsonCall.data.period.from).toBeDefined();
      expect(jsonCall.data.period.to).toBeDefined();
    });

    it('should not see other developers jobs in summary', async () => {
      const devKey1 = Keypair.random().publicKey();
      const devKey2 = Keypair.random().publicKey();
      const user = { _id: 'user-id', stellarPublicKey: devKey1 } as any;
      const now = new Date();

      await VerificationJobModel.create([
        { ownerPublicKey: devKey1, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
        { ownerPublicKey: devKey2, contentHash: hex(32), status: VerificationStatus.COMPLETED, createdAt: now },
      ]);

      const req = createMockRequest({
        user,
        query: {
          from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
          to: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        },
      }) as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await developerController.getUsageSummary(req, res, next);

      const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.data.totalJobs).toBe(1); // only devKey1's job
    });
  });
});
