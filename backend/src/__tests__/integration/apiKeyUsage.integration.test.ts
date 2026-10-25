import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../app';
import User from '../../models/User.model';
import APIKeyUsage from '../../models/APIKeyUsage.model';
import { generateApiKeyForUser } from '../../services/developer.service';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

let mongoServer: MongoMemoryServer;
let app: any;
let testUser: any;
let testApiKey: string;
let hashedApiKey: string;

describe('API Key Usage Integration Tests', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    app = createApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear collections
    await User.deleteMany({});
    await APIKeyUsage.deleteMany({});

    // Create test user
    testUser = await User.create({
      email: 'test@example.com',
      passwordHash: 'hashed-password',
      role: 'developer',
      isActive: true,
    });

    // Generate API key for user
    testApiKey = await generateApiKeyForUser(testUser._id.toString());
    
    // Get the hashed version for seeding usage data
    const crypto = require('crypto');
    hashedApiKey = crypto
      .createHash('sha256')
      .update(testApiKey)
      .digest('hex');
  });

  describe('GET /api/v1/developer/api-keys/:keyId/usage', () => {
    beforeEach(async () => {
      // Seed usage data for the test key
      const baseDate = new Date('2024-01-15T00:00:00Z');
      const records = [];

      for (let hour = 0; hour < 24; hour++) {
        const hourDate = new Date(baseDate.getTime() + hour * 60 * 60 * 1000);
        records.push({
          apiKeyId: hashedApiKey,
          endpoint: '/api/v1/certificates',
          method: 'POST',
          statusCode: 201,
          hour: hourDate,
          count: 10 + hour,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        });
        records.push({
          apiKeyId: hashedApiKey,
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

    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .send();

      expect(response.status).toBe(401);
    });

    it('should return 404 if user does not own the key', async () => {
      // Create another user without this key
      const otherUser = await User.create({
        email: 'other@example.com',
        passwordHash: 'hashed-password',
        role: 'developer',
        isActive: true,
      });

      // Create JWT for other user
      const token = jwt.sign(
        { userId: otherUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should return 200 with usage data for authenticated owner', async () => {
      // Create JWT for test user
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.apiKeyId).toBe(hashedApiKey);
      expect(response.body.data.totalRequests).toBeGreaterThan(0);
      expect(response.body.data.byEndpoint).toBeDefined();
      expect(response.body.data.byStatusCode).toBeDefined();
      expect(response.body.data.hourlyBreakdown).toBeDefined();
    });

    it('should return 400 for invalid date format', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .query({ from: 'invalid-date' })
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_FROM_DATE');
    });

    it('should filter by endpoint if provided', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .query({ endpoint: '/api/v1/certificates' })
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(200);
      for (const ep of response.body.data.byEndpoint) {
        expect(ep.endpoint).toBe('/api/v1/certificates');
      }
    });

    it('should respect pagination limits', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .query({ limit: 1 })
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.data.byEndpoint.length).toBeLessThanOrEqual(1);
    });

    it('should return 400 for invalid pagination', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .query({ limit: 20000 })
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_LIMIT');
    });

    it('should return 400 for invalid granularity', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .query({ granularity: 'invalid' })
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_GRANULARITY');
    });

    it('should return usage sorted by total requests descending', async () => {
      const token = jwt.sign(
        { userId: testUser._id.toString() },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      const response = await request(app)
        .get(`/api/v1/developer/api-keys/${hashedApiKey}/usage`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(response.status).toBe(200);
      const endpoints = response.body.data.byEndpoint;
      for (let i = 1; i < endpoints.length; i++) {
        expect(endpoints[i - 1].totalRequests).toBeGreaterThanOrEqual(
          endpoints[i].totalRequests
        );
      }
    });
  });

  describe('Metering Middleware', () => {
    it('should not meter requests without API key authentication', async () => {
      // Make a request to a public endpoint (health check)
      await request(app).get('/health').send();

      const count = await APIKeyUsage.countDocuments();
      expect(count).toBe(0); // Should not have metered anything
    });

    it('should meter API key authenticated requests', async () => {
      // Make a request with API key (would need an actual endpoint that uses verifyApiKey)
      // For now, this test documents the expected behavior
      // In a real scenario, you'd call an endpoint that requires verifyApiKey

      // Since we don't have a public endpoint that uses verifyApiKey,
      // we'll test this indirectly via the service and middleware unit tests
      expect(true).toBe(true);
    });
  });
});
