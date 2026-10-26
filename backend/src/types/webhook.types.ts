/**
 * Domain types for the outbound webhook delivery pipeline.
 *
 * A `WebhookDelivery` is the persisted record of one dispatch attempt cycle
 * against a developer's webhook endpoint. It stores the exact serialized
 * payload and the HMAC signature that were (or would have been) sent, so a
 * failed delivery can be replayed byte-for-byte later.
 *
 * Shared across all layers: models, services, controllers, and routes.
 */
import type { VerificationStatus, VerificationWebhookEvent } from "./verification.types";
import type { Types } from "mongoose";

// ---------------------------------------------------------------------------
// Queue pipeline types (webhook.service / webhookRegistration.service)
// ---------------------------------------------------------------------------

export type WebhookEventType = VerificationWebhookEvent;

export interface WebhookEventPayloadMap {
  [VerificationWebhookEvent.JOB_CREATED]: {
    jobId: string;
    contentHash: string;
    status: VerificationStatus;
  };
  [VerificationWebhookEvent.COMPLETED]: {
    jobId: string;
    contentHash: string;
    status: VerificationStatus;
    certificateId?: string;
    txHash?: string;
  };
  [VerificationWebhookEvent.FAILED]: {
    jobId: string;
    contentHash: string;
    status: VerificationStatus;
    errorMessage?: string;
  };
  [VerificationWebhookEvent.MINTED]: {
    jobId: string;
    contentHash: string;
    certificateId: string;
    txHash?: string;
  };
  [VerificationWebhookEvent.KMS_KEY_ROTATED]: {
    keyVersion: string;
    previousKeyVersion: string;
    assetsReEncrypted: number;
  };
}

export interface WebhookEvent<T extends WebhookEventType = WebhookEventType> {
  id: string;
  type: T;
  occurredAt: string;
  data: WebhookEventPayloadMap[T];
}

export interface WebhookSubscription {
  events: WebhookEventType[];
}

/** Lifecycle of a queued webhook delivery (queue pipeline). */
export type WebhookQueueDeliveryStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "failed"
  | "dead_letter";

export interface WebhookDeliverySummary {
  id: string;
  eventType: WebhookEventType;
  status: WebhookQueueDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  latencyMs: number | null;
  payloadPreview: string;
  createdAt: Date;
  deliveredAt?: Date;
  nextAttemptAt?: Date;
}

// ---------------------------------------------------------------------------
// Replay pipeline types (webhookDelivery.service / webhookSecret.service)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a replayable webhook delivery.
 *
 * State flow:
 *   pending   -> delivered | failed   (initial dispatch)
 *   failed    -> replaying            (replay claimed)
 *   replaying -> delivered | failed   (replay dispatched)
 *
 * Only deliveries in the `failed` state may be replayed.
 */
export enum WebhookDeliveryStatus {
  PENDING = "pending",
  DELIVERED = "delivered",
  FAILED = "failed",
  REPLAYING = "replaying",
}

/** Shape of a replayable WebhookDelivery document as stored in MongoDB. */
export interface IWebhookDelivery {
  _id?: string | Types.ObjectId;

  /**
   * Identifier of the webhook endpoint/channel this delivery belongs to.
   * Mirrors the `:id` segment of
   * `POST /api/v1/developer/webhooks/:id/deliveries/:deliveryId/replay`.
   */
  webhookId: string;

  /** User that owns the webhook endpoint; used for replay authorization. */
  owner?: Types.ObjectId;

  /** Event name conveyed by the payload, e.g. `verification.completed`. */
  event: string;

  /** Absolute http(s) URL the payload is dispatched to. */
  targetUrl: string;

  /** Exact serialized JSON body that is (re-)sent on every attempt. */
  payload: string;

  /** Hex-encoded HMAC-SHA256 signature of `payload`, reused verbatim on replay. */
  signature: string;

  /** Current lifecycle state. */
  status: WebhookDeliveryStatus;

  /** Number of dispatch attempts made so far (initial + replays). */
  attempts: number;

  /** HTTP status code returned by the endpoint on the last attempt. */
  responseStatus?: number;

  /** Human-readable reason for the last failure. */
  lastError?: string;

  /** When the last dispatch attempt was made. */
  lastAttemptAt?: Date;

  /** When the delivery was successfully received by the endpoint. */
  deliveredAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

/** Input for persisting and dispatching a new webhook delivery. */
export interface CreateWebhookDeliveryDTO {
  webhookId: string;
  owner?: string;
  event: string;
  targetUrl: string;
  /** Object about to be serialized; the service owns serialization. */
  payload: Record<string, unknown>;
  /** Shared secret used to HMAC-sign the payload. */
  secret: string;
}

/** Requester identity required to authorize a replay. */
export interface ReplayWebhookDeliveryRequester {
  id: string;
  role: "creator" | "developer" | "admin";
}

/** Path parameters for the replay endpoint. */
export interface ReplayWebhookDeliveryParams {
  webhookId: string;
  deliveryId: string;
}

/** Result of a replay attempt. */
export interface ReplayWebhookDeliveryResult {
  delivery: IWebhookDelivery;
  /** HTTP status returned by the endpoint, present when a response was received. */
  responseStatus?: number;
  /** Whether the replay attempt succeeded. */
  delivered: boolean;
}
