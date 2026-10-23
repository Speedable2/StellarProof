/**
 * WebhookDeliveryService unit tests.
 *
 * The Mongoose model and global fetch are mocked so the replay state machine
 * (fetch -> authorize -> atomic claim -> re-dispatch stored bytes -> persist)
 * is exercised without a database or network.
 */
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { Types } from 'mongoose';
import { WebhookDeliveryModel } from '../models/WebhookDelivery.model';
import {
  WebhookDeliveryService,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_DELIVERY_HEADER,
} from '../services/webhookDelivery.service';
import { WebhookDeliveryStatus } from '../types/webhook.types';
import type { IWebhookDelivery } from '../types/webhook.types';
import { AppError } from '../errors/AppError';

jest.mock('../models/WebhookDelivery.model', () => ({
  __esModule: true,
  WebhookDeliveryModel: {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

const MockedModel = WebhookDeliveryModel as unknown as {
  create: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findByIdAndUpdate: jest.Mock;
};

/** Wraps a resolved value in the `{ lean() }` query shape the service chains. */
function query(result: unknown) {
  return { lean: jest.fn().mockResolvedValue(result) };
}

function okResponse(status = 200) {
  return { ok: true, status };
}

function errorResponse(status = 500) {
  return { ok: false, status };
}

function buildDelivery(overrides: Partial<IWebhookDelivery> = {}): IWebhookDelivery {
  return {
    _id: new Types.ObjectId(),
    webhookId: 'wh-1',
    owner: new Types.ObjectId(),
    event: 'verification.completed',
    targetUrl: 'https://example.com/webhook',
    payload: '{"event":"verification.completed","jobId":"job-1"}',
    signature: 'a'.repeat(64),
    status: WebhookDeliveryStatus.FAILED,
    attempts: 3,
    lastError: 'Endpoint responded with status 500',
    lastAttemptAt: new Date('2026-10-20T00:00:00Z'),
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    ...overrides,
  };
}

const fetchMock = jest.fn();

describe('WebhookDeliveryService.replayFailedDelivery', () => {
  const service = new WebhookDeliveryService();
  const requesterId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue(okResponse());
  });

  it('re-dispatches the stored payload with the stored signature and marks it delivered', async () => {
    const delivery = buildDelivery();
    const deliveryId = String(delivery._id);

    MockedModel.findOne.mockReturnValue(query(delivery));
    MockedModel.findOneAndUpdate
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.REPLAYING }))
      .mockReturnValueOnce(
        query({
          ...delivery,
          status: WebhookDeliveryStatus.DELIVERED,
          attempts: 4,
          responseStatus: 200,
          deliveredAt: new Date(),
        })
      );

    const result = await service.replayFailedDelivery(
      { webhookId: 'wh-1', deliveryId },
      { id: String(delivery.owner), role: 'developer' }
    );

    expect(result.delivered).toBe(true);
    expect(result.responseStatus).toBe(200);
    expect(result.delivery.status).toBe(WebhookDeliveryStatus.DELIVERED);
    expect(result.delivery.attempts).toBe(4);

    // Exactly one POST, to the stored URL, with the exact stored bytes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(delivery.targetUrl);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(delivery.payload);
    expect(init.headers['Content-Type']).toBe('application/json');
    // The stored signature is reused verbatim, never recomputed.
    expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(delivery.signature);
    expect(init.headers[WEBHOOK_EVENT_HEADER]).toBe(delivery.event);
    expect(init.headers[WEBHOOK_ID_HEADER]).toBe(delivery.webhookId);
    expect(init.headers[WEBHOOK_DELIVERY_HEADER]).toBe(deliveryId);
  });

  it('claims the delivery with an atomic failed -> replaying compare-and-swap', async () => {
    const delivery = buildDelivery();
    const deliveryId = String(delivery._id);

    MockedModel.findOne.mockReturnValue(query(delivery));
    MockedModel.findOneAndUpdate
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.REPLAYING }))
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.DELIVERED }));

    await service.replayFailedDelivery(
      { webhookId: 'wh-1', deliveryId },
      { id: String(delivery.owner), role: 'developer' }
    );

    const [claimFilter, claimUpdate] = MockedModel.findOneAndUpdate.mock.calls[0];
    expect(claimFilter._id).toBe(deliveryId);
    expect(claimFilter.webhookId).toBe('wh-1');
    expect(claimFilter.status).toBe(WebhookDeliveryStatus.FAILED);
    expect(claimUpdate).toEqual({
      $set: { status: WebhookDeliveryStatus.REPLAYING },
      $inc: { attempts: 1 },
    });
  });

  it('keeps the delivery failed with the recorded error when the endpoint rejects the replay', async () => {
    const delivery = buildDelivery();
    fetchMock.mockResolvedValue(errorResponse(503));

    MockedModel.findOne.mockReturnValue(query(delivery));
    MockedModel.findOneAndUpdate
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.REPLAYING }))
      .mockReturnValueOnce(
        query({
          ...delivery,
          status: WebhookDeliveryStatus.FAILED,
          attempts: 4,
          responseStatus: 503,
          lastError: 'Endpoint responded with status 503',
        })
      );

    const result = await service.replayFailedDelivery(
      { webhookId: 'wh-1', deliveryId: String(delivery._id) },
      { id: String(delivery.owner), role: 'developer' }
    );

    expect(result.delivered).toBe(false);
    expect(result.responseStatus).toBe(503);
    expect(result.delivery.status).toBe(WebhookDeliveryStatus.FAILED);
    expect(result.delivery.lastError).toBe('Endpoint responded with status 503');
  });

  it('records a network failure without a response status', async () => {
    const delivery = buildDelivery();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    MockedModel.findOne.mockReturnValue(query(delivery));
    MockedModel.findOneAndUpdate
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.REPLAYING }))
      .mockReturnValueOnce(
        query({
          ...delivery,
          status: WebhookDeliveryStatus.FAILED,
          attempts: 4,
          lastError: 'Dispatch failed: ECONNREFUSED',
        })
      );

    const result = await service.replayFailedDelivery(
      { webhookId: 'wh-1', deliveryId: String(delivery._id) },
      { id: String(delivery.owner), role: 'developer' }
    );

    expect(result.delivered).toBe(false);
    expect(result.responseStatus).toBeUndefined();
  });

  it('rejects replay of a delivery that is not failed', async () => {
    const delivery = buildDelivery({ status: WebhookDeliveryStatus.DELIVERED });
    MockedModel.findOne.mockReturnValue(query(delivery));

    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: String(delivery._id) },
        { id: String(delivery.owner), role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_REPLAYABLE', statusCode: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockedModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects replay while another replay is in flight', async () => {
    const delivery = buildDelivery({
      status: WebhookDeliveryStatus.REPLAYING,
      updatedAt: new Date(), // fresh claim – not stale
    });
    MockedModel.findOne.mockReturnValue(query(delivery));

    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: String(delivery._id) },
        { id: String(delivery.owner), role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_REPLAYABLE', statusCode: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a replaying delivery even when its claim is stale', async () => {
    const delivery = buildDelivery({
      status: WebhookDeliveryStatus.REPLAYING,
      updatedAt: new Date(Date.now() - 5 * 60_000), // older than the stale window
    });

    MockedModel.findOne.mockReturnValue(query(delivery));
    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: String(delivery._id) },
        { id: String(delivery.owner), role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_REPLAYABLE', statusCode: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockedModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the delivery does not belong to the webhook', async () => {
    MockedModel.findOne.mockReturnValue(query(null));

    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: new Types.ObjectId().toHexString() },
        { id: requesterId, role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND', statusCode: 404 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forbids a non-owner non-admin requester', async () => {
    const delivery = buildDelivery();
    MockedModel.findOne.mockReturnValue(query(delivery));

    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: String(delivery._id) },
        { id: requesterId, role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_FORBIDDEN', statusCode: 403 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockedModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows an admin to replay a delivery without an owner', async () => {
    const delivery = buildDelivery({ owner: undefined });

    MockedModel.findOne.mockReturnValue(query(delivery));
    MockedModel.findOneAndUpdate
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.REPLAYING }))
      .mockReturnValueOnce(query({ ...delivery, status: WebhookDeliveryStatus.DELIVERED }));

    const result = await service.replayFailedDelivery(
      { webhookId: 'wh-1', deliveryId: String(delivery._id) },
      { id: requesterId, role: 'admin' }
    );

    expect(result.delivered).toBe(true);
  });

  it('returns 409 when a concurrent replay wins the atomic claim', async () => {
    const delivery = buildDelivery();
    MockedModel.findOne.mockReturnValue(query(delivery));
    // Claim misses: another request flipped the status between read and claim.
    MockedModel.findOneAndUpdate.mockReturnValueOnce(query(null));

    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: String(delivery._id) },
        { id: String(delivery.owner), role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'DELIVERY_ALREADY_REPLAYING', statusCode: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed deliveryId before touching the database', async () => {
    await expect(
      service.replayFailedDelivery(
        { webhookId: 'wh-1', deliveryId: 'not-an-objectid' },
        { id: requesterId, role: 'developer' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_DELIVERY_ID', statusCode: 400 });

    expect(MockedModel.findOne).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty webhookId before touching the database', async () => {
    await expect(
      service.replayFailedDelivery(
        { webhookId: '   ', deliveryId: new Types.ObjectId().toHexString() },
        { id: requesterId, role: 'developer' }
      )
    ).rejects.toBeInstanceOf(AppError);

    expect(MockedModel.findOne).not.toHaveBeenCalled();
  });
});

describe('WebhookDeliveryService.createAndDispatch', () => {
  const service = new WebhookDeliveryService();
  const ownerHex = new Types.ObjectId().toHexString();
  const dto = {
    webhookId: 'wh-1',
    owner: ownerHex,
    event: 'verification.completed',
    targetUrl: 'https://example.com/webhook',
    payload: { event: 'verification.completed', jobId: 'job-1' },
    secret: 'webhook-secret',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue(okResponse());
  });

  it('persists the signed payload and records a successful delivery', async () => {
    const deliveryId = new Types.ObjectId();
    MockedModel.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      _id: deliveryId,
      ...doc,
      toObject: () => ({ _id: deliveryId, ...doc }),
    }));
    MockedModel.findByIdAndUpdate.mockReturnValue(
      query({
        _id: deliveryId,
        ...dto,
        status: WebhookDeliveryStatus.DELIVERED,
        attempts: 1,
        responseStatus: 200,
      })
    );

    const result = await service.createAndDispatch(dto);

    const createdDoc = MockedModel.create.mock.calls[0][0];
    expect(createdDoc.webhookId).toBe('wh-1');
    expect(createdDoc.owner.toHexString()).toBe(ownerHex);
    expect(createdDoc.payload).toBe(JSON.stringify(dto.payload));
    // HMAC-SHA256 of the exact serialized payload with the caller's secret.
    expect(createdDoc.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(createdDoc.status).toBe(WebhookDeliveryStatus.PENDING);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(dto.targetUrl);
    expect(init.body).toBe(JSON.stringify(dto.payload));
    expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(createdDoc.signature);

    expect(result.status).toBe(WebhookDeliveryStatus.DELIVERED);
  });

  it('marks the delivery failed when the endpoint rejects the initial dispatch', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));

    const deliveryId = new Types.ObjectId();
    MockedModel.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      _id: deliveryId,
      ...doc,
      toObject: () => ({ _id: deliveryId, ...doc }),
    }));
    MockedModel.findByIdAndUpdate.mockReturnValue(
      query({
        _id: deliveryId,
        ...dto,
        status: WebhookDeliveryStatus.FAILED,
        attempts: 1,
        responseStatus: 500,
        lastError: 'Endpoint responded with status 500',
      })
    );

    const result = await service.createAndDispatch(dto);

    expect(result.status).toBe(WebhookDeliveryStatus.FAILED);
    expect(result.lastError).toBe('Endpoint responded with status 500');
  });
});
