import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import WebhookRegistration from '../../models/WebhookRegistration.model';
import { VerificationWebhookEvent } from '../../types/verification.types';
import { webhookRegistrationService } from '../webhookRegistration.service';

jest.setTimeout(180_000);

describe('WebhookRegistrationService', () => {
  let mongo: MongoMemoryServer;
  const ownerId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'ab'.repeat(32);
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    await WebhookRegistration.deleteMany({});
  });

  it('creates, lists, updates, and deletes registrations owned by the caller', async () => {
    const { registration, secret } = await webhookRegistrationService.create(String(ownerId), {
      url: 'https://hooks.example.com/verification',
      events: [VerificationWebhookEvent.COMPLETED],
    });
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(registration.secretEncrypted).toMatch(/^v1:/);
    expect(registration.secretEncrypted).not.toContain(secret);
    expect(registration.isActive).toBe(true);

    const listed = await webhookRegistrationService.list(String(ownerId));
    expect(listed).toHaveLength(1);
    expect(listed[0].secretEncrypted).toBeUndefined();

    const updated = await webhookRegistrationService.update(String(ownerId), String(registration._id), { isActive: false });
    expect(updated.isActive).toBe(false);
    await webhookRegistrationService.remove(String(ownerId), String(registration._id));
    expect(await webhookRegistrationService.list(String(ownerId))).toHaveLength(0);
  });

  it('rejects invalid URLs, empty subscriptions, and cross-owner access', async () => {
    await expect(webhookRegistrationService.create(String(ownerId), {
      url: 'javascript:alert(1)', events: [VerificationWebhookEvent.COMPLETED],
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(webhookRegistrationService.create(String(ownerId), {
      url: 'https://hooks.example.com', events: [],
    })).rejects.toMatchObject({ statusCode: 400 });

    const { registration } = await webhookRegistrationService.create(String(ownerId), {
      url: 'https://hooks.example.com', events: [VerificationWebhookEvent.FAILED],
    });
    await expect(webhookRegistrationService.update(String(new mongoose.Types.ObjectId()), String(registration._id), { isActive: false }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
