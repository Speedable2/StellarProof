import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import APIKeyUsage from '../../models/APIKeyUsage.model';
import { apiKeyUsageService } from '../../services/apiKeyUsage.service';

let mongoServer: MongoMemoryServer;

describe('APIKeyUsageService', () => {
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
    // Clear all collections before each test
    await APIKeyUsage.deleteMany({});
  });

  describe('recordUsage', () => {
    it('should create a new usage bucket for a request', async () => {
      const apiKeyId = 'test-key-hash-1';
      const endpoint = '/api/v1/certificates';
      const method = 'POST';
      const statusCode = 201;
      const timestamp = new Date('2024-01-15T14:37:22Z');

      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        timestamp,
      });

      const bucket = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
      });

      expect(bucket).toBeDefined();
      expect(bucket?.count).toBe(1);
      expect(bucket?.hour).toEqual(new Date('2024-01-15T14:00:00Z'));
      expect(bucket?.firstSeenAt).toBeDefined();
      expect(bucket?.lastSeenAt).toBeDefined();
    });

    it('should increment count for repeated requests in the same hour bucket', async () => {
      const apiKeyId = 'test-key-hash-2';
      const endpoint = '/api/v1/certificates';
      const method = 'GET';
      const statusCode = 200;

      // Record first request
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        timestamp: new Date('2024-01-15T14:15:00Z'),
      });

      // Record second request in same hour
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        timestamp: new Date('2024-01-15T14:45:00Z'),
      });

      const bucket = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
      });

      expect(bucket?.count).toBe(2);
    });

    it('should place requests at hour boundaries in different buckets', async () => {
      const apiKeyId = 'test-key-hash-3';
      const endpoint = '/api/v1/certificates';
      const method = 'POST';
      const statusCode = 201;

      // Request at 12:59:59.999 UTC
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        timestamp: new Date('2024-01-15T12:59:59.999Z'),
      });

      // Request at 13:00:00.000 UTC
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        timestamp: new Date('2024-01-15T13:00:00.000Z'),
      });

      const bucket12 = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        hour: new Date('2024-01-15T12:00:00Z'),
      });

      const bucket13 = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        hour: new Date('2024-01-15T13:00:00Z'),
      });

      expect(bucket12?.count).toBe(1);
      expect(bucket13?.count).toBe(1);
    });

    it('should handle concurrent requests atomically', async () => {
      const apiKeyId = 'test-key-hash-4';
      const endpoint = '/api/v1/certificates';
      const method = 'GET';
      const statusCode = 200;

      // Simulate 10 concurrent requests
      const promises = Array.from({ length: 10 }, (_, i) =>
        apiKeyUsageService.recordUsage({
          apiKeyId,
          endpoint,
          method,
          statusCode,
          timestamp: new Date(`2024-01-15T14:${String(i).padStart(2, '0')}:00Z`),
        })
      );

      await Promise.all(promises);

      const bucket = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
      });

      // Count should be exactly 10, never lose increments
      expect(bucket?.count).toBe(10);
    });

    it('should use current timestamp if not provided', async () => {
      const apiKeyId = 'test-key-hash-5';
      const endpoint = '/api/v1/certificates';
      const method = 'POST';
      const statusCode = 201;

      const beforeTime = new Date();
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode,
      });
      const afterTime = new Date();

      const bucket = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode,
      });

      expect(bucket?.hour).toBeDefined();
      expect(bucket!.hour.getTime()).toBeGreaterThanOrEqual(
        new Date(beforeTime.getFullYear(), beforeTime.getMonth(), beforeTime.getDate(),
          beforeTime.getHours(), 0, 0).getTime()
      );
    });

    it('should track different status codes separately', async () => {
      const apiKeyId = 'test-key-hash-6';
      const endpoint = '/api/v1/certificates';
      const method = 'POST';
      const timestamp = new Date('2024-01-15T14:30:00Z');

      // Record 200 response
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode: 200,
        timestamp,
      });

      // Record 400 response
      await apiKeyUsageService.recordUsage({
        apiKeyId,
        endpoint,
        method,
        statusCode: 400,
        timestamp,
      });

      const success = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode: 200,
      });

      const error = await APIKeyUsage.findOne({
        apiKeyId,
        endpoint,
        method,
        statusCode: 400,
      });

      expect(success?.count).toBe(1);
      expect(error?.count).toBe(1);
    });
  });

  describe('getCurrentPeriodTotal', () => {
    it('should return total requests for a period', async () => {
      const apiKeyId = 'test-key-hash-7';
      const periodStart = new Date('2024-01-15T14:00:00Z');

      // Create usage in this period
      await APIKeyUsage.create([
        {
          apiKeyId,
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: periodStart,
          count: 5,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
        {
          apiKeyId,
          endpoint: '/api/v1/manifests',
          method: 'GET',
          statusCode: 200,
          hour: periodStart,
          count: 3,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      ]);

      const total = await apiKeyUsageService.getCurrentPeriodTotal(
        apiKeyId,
        periodStart
      );

      expect(total).toBe(8);
    });

    it('should return 0 if no usage found', async () => {
      const total = await apiKeyUsageService.getCurrentPeriodTotal(
        'nonexistent-key',
        new Date()
      );

      expect(total).toBe(0);
    });

    it('should only count usage at or after periodStart', async () => {
      const apiKeyId = 'test-key-hash-8';
      const hour1 = new Date('2024-01-15T13:00:00Z');
      const hour2 = new Date('2024-01-15T14:00:00Z');

      await APIKeyUsage.create([
        {
          apiKeyId,
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: hour1,
          count: 5,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
        {
          apiKeyId,
          endpoint: '/api/v1/manifests',
          method: 'GET',
          statusCode: 200,
          hour: hour2,
          count: 3,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      ]);

      const total = await apiKeyUsageService.getCurrentPeriodTotal(
        apiKeyId,
        hour2
      );

      expect(total).toBe(3); // Only hour2's count
    });
  });

  describe('getUsageByKey', () => {
    beforeEach(async () => {
      // Seed test data
      const baseDate = new Date('2024-01-15T00:00:00Z');
      const records = [];

      for (let hour = 0; hour < 24; hour++) {
        const hourDate = new Date(baseDate.getTime() + hour * 60 * 60 * 1000);
        records.push({
          apiKeyId: 'test-key-hash-9',
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: hourDate,
          count: 10 + hour,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        });
        records.push({
          apiKeyId: 'test-key-hash-9',
          endpoint: '/api/v1/manifests',
          method: 'GET',
          statusCode: 200,
          hour: hourDate,
          count: 5,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      await APIKeyUsage.insertMany(records);
    });

    it('should return aggregated usage with totals and breakdowns', async () => {
      const usage = await apiKeyUsageService.getUsageByKey('test-key-hash-9', {
        from: new Date('2024-01-15T00:00:00Z'),
        to: new Date('2024-01-16T00:00:00Z'),
      });

      expect(usage).toBeDefined();
      expect(usage.apiKeyId).toBe('test-key-hash-9');
      expect(usage.totalRequests).toBeGreaterThan(0);
      expect(usage.byEndpoint).toBeDefined();
      expect(usage.byStatusCode).toBeDefined();
      expect(usage.hourlyBreakdown).toBeDefined();
    });

    it('should respect date range filtering', async () => {
      const usage = await apiKeyUsageService.getUsageByKey('test-key-hash-9', {
        from: new Date('2024-01-15T12:00:00Z'),
        to: new Date('2024-01-15T14:00:00Z'),
      });

      expect(usage.hourlyBreakdown.length).toBeLessThanOrEqual(3);
    });

    it('should filter by endpoint if provided', async () => {
      const usage = await apiKeyUsageService.getUsageByKey('test-key-hash-9', {
        from: new Date('2024-01-15T00:00:00Z'),
        to: new Date('2024-01-16T00:00:00Z'),
        endpoint: '/api/v1/certificates',
      });

      for (const ep of usage.byEndpoint) {
        expect(ep.endpoint).toBe('/api/v1/certificates');
      }
    });

    it('should enforce max query window', async () => {
      // This test depends on env config; set a reasonable default
      await expect(
        apiKeyUsageService.getUsageByKey('test-key-hash-9', {
          from: new Date('2020-01-01T00:00:00Z'),
          to: new Date('2024-01-15T00:00:00Z'),
        })
      ).rejects.toThrow('Query window exceeds maximum');
    });

    it('should reject invalid date ranges', async () => {
      await expect(
        apiKeyUsageService.getUsageByKey('test-key-hash-9', {
          from: new Date('2024-01-16T00:00:00Z'),
          to: new Date('2024-01-15T00:00:00Z'),
        })
      ).rejects.toThrow('Query start date must be before end date');
    });

    it('should paginate results', async () => {
      const page1 = await apiKeyUsageService.getUsageByKey('test-key-hash-9', {
        from: new Date('2024-01-15T00:00:00Z'),
        to: new Date('2024-01-16T00:00:00Z'),
        limit: 1,
        skip: 0,
      });

      const page2 = await apiKeyUsageService.getUsageByKey('test-key-hash-9', {
        from: new Date('2024-01-15T00:00:00Z'),
        to: new Date('2024-01-16T00:00:00Z'),
        limit: 1,
        skip: 1,
      });

      expect(page1.byEndpoint).toHaveLength(1);
      expect(page2.byEndpoint).toHaveLength(1);
      // Results should be different due to different skip
      if (page1.byEndpoint.length > 0 && page2.byEndpoint.length > 0) {
        // They might have different endpoints or same endpoint but different order
        expect(page1.byEndpoint[0]).toBeDefined();
        expect(page2.byEndpoint[0]).toBeDefined();
      }
    });
  });

  describe('cleanupOldRecords', () => {
    it('should delete records older than specified days', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5); // 5 days ago

      await APIKeyUsage.create([
        {
          apiKeyId: 'old-key',
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: oldDate,
          count: 1,
          firstSeenAt: oldDate,
          lastSeenAt: oldDate,
          createdAt: oldDate,
        },
        {
          apiKeyId: 'recent-key',
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: recentDate,
          count: 1,
          firstSeenAt: recentDate,
          lastSeenAt: recentDate,
          createdAt: recentDate,
        },
      ]);

      const deleted = await apiKeyUsageService.cleanupOldRecords(90);

      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = await APIKeyUsage.countDocuments();
      expect(remaining).toBe(1);
    });
  });
});
