import crypto from "crypto";
import WebhookDelivery from "../../models/WebhookDelivery.model";
import WebhookRegistration from "../../models/WebhookRegistration.model";
import { webhookDeliveryService } from "../webhookDelivery.service";
import { createWebhookEvent, webhookService } from "../webhook.service";
import { VerificationStatus, VerificationWebhookEvent } from "../../types/verification.types";
import { decryptWebhookSecret, encryptWebhookSecret } from "../../utils/webhookSecrets";

jest.mock("../../models/WebhookDelivery.model", () => ({
  __esModule: true,
  default: {
    bulkWrite: jest.fn(),
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
  },
}));
jest.mock("../../models/WebhookRegistration.model", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findOne: jest.fn(),
    exists: jest.fn(),
  },
}));

const ENCRYPTION_KEY = "a".repeat(64);
const ORIGINAL_ENCRYPTION_KEY = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
const ownerId = "a".repeat(24);
const registrationId = "b".repeat(24);
const secret = "b".repeat(64);
let fetchMock: jest.SpyInstance;

function completedEvent() {
  return createWebhookEvent(VerificationWebhookEvent.COMPLETED, {
    jobId: "job-789",
    contentHash: "c".repeat(64),
    status: VerificationStatus.COMPLETED,
  });
}

function makeDelivery(event: ReturnType<typeof completedEvent>, attempts = 1, maxAttempts = 5) {
  return {
    _id: "delivery-012",
    registrationId,
    ownerId,
    eventId: event.id,
    eventType: event.type,
    payload: event,
    payloadPreview: JSON.stringify(event),
    status: "processing",
    attempts,
    maxAttempts,
    nextAttemptAt: new Date(),
    set: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function setClaimResults(...deliveries: Array<ReturnType<typeof makeDelivery> | null>): void {
  for (const delivery of deliveries) {
    (WebhookDelivery.findOneAndUpdate as jest.Mock).mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue(delivery),
    });
  }
}

beforeAll(() => {
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

afterEach(() => {
  fetchMock?.mockRestore();
  jest.clearAllMocks();
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
});

describe("webhook registrations and delivery queue", () => {
  it("creates the shared envelope for all supported event payloads", () => {
    const events = [
      createWebhookEvent(VerificationWebhookEvent.JOB_CREATED, {
        jobId: "job-1",
        contentHash: "c".repeat(64),
        status: VerificationStatus.PENDING,
      }),
      completedEvent(),
      createWebhookEvent(VerificationWebhookEvent.FAILED, {
        jobId: "job-1",
        contentHash: "c".repeat(64),
        status: VerificationStatus.FAILED,
        errorMessage: "verification failed",
      }),
      createWebhookEvent(VerificationWebhookEvent.MINTED, {
        jobId: "job-1",
        contentHash: "c".repeat(64),
        certificateId: "cert-1",
      }),
      createWebhookEvent(VerificationWebhookEvent.KMS_KEY_ROTATED, {
        keyVersion: "v2",
        previousKeyVersion: "v1",
        assetsReEncrypted: 2,
      }),
    ];
    expect(events.map(({ type }) => type)).toEqual(Object.values(VerificationWebhookEvent));
    for (const event of events) {
      expect(event).toEqual(expect.objectContaining({ id: expect.any(String), occurredAt: expect.any(String), data: expect.any(Object) }));
    }
  });

  it("encrypts registration secrets and signs the exact JSON bytes sent", async () => {
    const encrypted = encryptWebhookSecret(secret, ownerId, registrationId);
    expect(encrypted).not.toContain(secret);
    expect(decryptWebhookSecret(encrypted, ownerId, registrationId)).toBe(secret);
    expect(() => decryptWebhookSecret(encrypted, "another-owner", registrationId)).toThrow();

    (WebhookRegistration.find as jest.Mock).mockReturnValue({
      select: () => ({ lean: async () => [{ _id: registrationId, ownerId }] }),
    });
    (WebhookDelivery.bulkWrite as jest.Mock).mockResolvedValue({ upsertedCount: 1 });
    const event = completedEvent();
    await expect(webhookService.enqueueForOwner(ownerId, event)).resolves.toBe(1);

    const registration = {
      _id: registrationId,
      ownerId,
      url: "https://example.test/hooks",
      secretEncrypted: encrypted,
    };
    (WebhookRegistration.findOne as jest.Mock).mockReturnValue({
      select: () => ({ exec: async () => registration }),
    });
    (WebhookDelivery.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
    const delivery = makeDelivery(event);
    setClaimResults(delivery, null);
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await expect(webhookService.processDueDeliveries()).resolves.toBe(1);
    const [, request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const rawBody = String(request.body);
    const header = new Headers(request.headers).get("X-StellarProof-Signature");
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? "");
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(
      crypto.createHmac("sha256", secret).update(`${match?.[1]}.${rawBody}`).digest("hex")
    );
    expect(JSON.parse(rawBody)).toEqual(event);
    expect(delivery).toMatchObject({ status: "delivered", responseCode: 204 });
    expect(delivery.attempts).toBe(1);
  });

  it("applies exponential retry scheduling and dead-letters after the maximum attempts", async () => {
    const event = completedEvent();
    const encrypted = encryptWebhookSecret(secret, ownerId, registrationId);
    (WebhookRegistration.findOne as jest.Mock).mockReturnValue({
      select: () => ({ exec: async () => ({
        _id: registrationId,
        ownerId,
        url: "https://example.test/hooks",
        secretEncrypted: encrypted,
      }) }),
    });
    (WebhookDelivery.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    const firstAttempt = makeDelivery(event, 1, 2);
    setClaimResults(firstAttempt, null);
    await webhookService.processDueDeliveries();
    expect(firstAttempt).toMatchObject({ status: "failed", responseCode: 503 });
    expect(firstAttempt.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    const finalAttempt = makeDelivery(event, 2, 2);
    setClaimResults(finalAttempt, null);
    await webhookService.processDueDeliveries();
    expect(finalAttempt).toMatchObject({ status: "dead_letter", attempts: 2, responseCode: 503 });
  });

  it("returns paginated delivery status and previews only for the registration owner", async () => {
    (WebhookRegistration.exists as jest.Mock).mockResolvedValue({ _id: registrationId });
    const row = {
      _id: "delivery-012",
      eventType: VerificationWebhookEvent.COMPLETED,
      status: "pending",
      attempts: 0,
      payloadPreview: '{"id":"evt-1"}',
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      nextAttemptAt: new Date("2026-01-01T00:00:05.000Z"),
    };
    (WebhookDelivery.find as jest.Mock).mockReturnValue({
      select: () => ({
        sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [row] }) }) }),
      }),
    });
    (WebhookDelivery.countDocuments as jest.Mock).mockResolvedValue(1);

    const page = await webhookDeliveryService.listForRegistration(ownerId, registrationId, 20, 0);
    expect(page).toMatchObject({ total: 1, limit: 20, skip: 0 });
    expect(page.deliveries[0]).toMatchObject({
      id: "delivery-012",
      status: "pending",
      attempts: 0,
      responseCode: null,
      latencyMs: null,
      payloadPreview: '{"id":"evt-1"}',
    });
    expect(WebhookRegistration.exists).toHaveBeenCalledWith({ _id: registrationId, ownerId });
  });
});
