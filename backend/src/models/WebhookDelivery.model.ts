/**
 * Mongoose model for WebhookDelivery documents.
 *
 * The model serves two reconciled pipelines:
 *
 * 1. Queue pipeline (default export) – used by `webhook.service.ts`,
 *    `webhookDelivery.job.ts` and `verification.service.ts`. Each delivery
 *    references a `WebhookRegistration` plus `ownerId`, carries a single
 *    `WebhookEvent` payload, and flows through
 *    pending -> processing -> delivered | failed -> dead_letter with
 *    exponential backoff.
 *
 * 2. Replay pipeline (named export `WebhookDeliveryModel`) – used by
 *    `webhookDelivery.service.ts` and `webhookSecret.service.ts`. Each
 *    delivery stores the exact serialized payload and HMAC signature so a
 *    failed delivery can be replayed byte-for-byte (`failed` -> `replaying`
 *    -> delivered | failed).
 */
import mongoose, { Schema, model, Document } from "mongoose";
import { VerificationWebhookEvent } from "../types/verification.types";
import { WebhookDeliveryStatus } from "../types/webhook.types";
import type { WebhookQueueDeliveryStatus, WebhookEvent, WebhookEventType } from "../types/webhook.types";
import type { IWebhookDelivery } from "../types/webhook.types";

export type WebhookDeliveryDocument = IWebhookDelivery & Document;

// Replay pipeline schema: byte-exact payload + signature for verbatim replays.
const ALL_REPLAY_STATUSES = Object.values(WebhookDeliveryStatus);

const ReplayWebhookDeliverySchema = new Schema<WebhookDeliveryDocument>(
  {
    webhookId: {
      type: String,
      required: [true, "webhookId is required"],
      trim: true,
      index: true,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: undefined,
    },
    event: {
      type: String,
      required: [true, "event is required"],
      trim: true,
    },
    targetUrl: {
      type: String,
      required: [true, "targetUrl is required"],
      trim: true,
      validate: {
        validator: (value: string): boolean => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === "http:" || parsed.protocol === "https:";
          } catch {
            return false;
          }
        },
        message: "targetUrl must be a valid http(s) URL",
      },
    },
    payload: {
      type: String,
      required: [true, "payload is required"],
    },
    signature: {
      type: String,
      required: [true, "signature is required"],
      trim: true,
    },
    status: {
      type: String,
      required: [true, "status is required"],
      enum: {
        values: ALL_REPLAY_STATUSES,
        message: `status must be one of: ${ALL_REPLAY_STATUSES.join(", ")}`,
      },
      default: WebhookDeliveryStatus.PENDING,
      index: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    responseStatus: {
      type: Number,
      default: undefined,
    },
    lastError: {
      type: String,
      trim: true,
      default: undefined,
    },
    lastAttemptAt: {
      type: Date,
      default: undefined,
    },
    deliveredAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Composite index: look up a specific delivery within a developer's webhook
// channel, optionally filtered by lifecycle state.
ReplayWebhookDeliverySchema.index({ webhookId: 1, _id: 1 });
ReplayWebhookDeliverySchema.index({ webhookId: 1, status: 1, updatedAt: -1 });

export const WebhookDeliveryModel = model<WebhookDeliveryDocument>(
  "WebhookDelivery",
  ReplayWebhookDeliverySchema
);

// ---------------------------------------------------------------------------
// Queue pipeline schema (default export): jobs -> registrations -> deliveries
// ---------------------------------------------------------------------------

export interface IQueueWebhookDelivery extends Document {
  registrationId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  eventId: string;
  eventType: WebhookEventType;
  payload: WebhookEvent;
  payloadPreview: string;
  status: WebhookQueueDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockExpiresAt?: Date;
  responseCode?: number;
  latencyMs?: number;
  lastError?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const QueueWebhookDeliverySchema = new Schema<IQueueWebhookDelivery>(
  {
    registrationId: {
      type: Schema.Types.ObjectId,
      ref: "WebhookRegistration",
      required: true,
      index: true,
    },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    eventId: { type: String, required: true },
    eventType: {
      type: String,
      required: true,
      enum: Object.values(VerificationWebhookEvent),
    },
    payload: { type: Schema.Types.Mixed, required: true },
    payloadPreview: { type: String, required: true, maxlength: 512 },
    status: {
      type: String,
      required: true,
      enum: ["pending", "processing", "delivered", "failed", "dead_letter"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, default: 5, min: 1 },
    nextAttemptAt: { type: Date, required: true, default: Date.now, index: true },
    lockExpiresAt: { type: Date },
    responseCode: { type: Number, min: 100, max: 599 },
    latencyMs: { type: Number, min: 0 },
    lastError: { type: String, maxlength: 1000 },
    deliveredAt: { type: Date },
  },
  { timestamps: true }
);

QueueWebhookDeliverySchema.index({ registrationId: 1, eventId: 1 }, { unique: true });
QueueWebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export default (mongoose.models.WebhookDelivery as mongoose.Model<IQueueWebhookDelivery> | undefined) ??
  mongoose.model<IQueueWebhookDelivery>("WebhookDelivery", QueueWebhookDeliverySchema);
