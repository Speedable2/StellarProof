/**
 * Mongoose model for WebhookDelivery documents.
 *
 * Schema design decisions:
 * - `payload` and `signature` are persisted verbatim so a failed delivery can
 *   be replayed byte-for-byte, exactly as the endpoint first received it.
 * - `webhookId` is indexed (not unique): a webhook endpoint accumulates many
 *   deliveries over time.
 * - `owner` is indexed: efficient authorization scoping per developer.
 * - `status` is indexed: efficient filtering for failed deliveries pending
 *   replay.
 * - Timestamps are enabled via Mongoose options (adds `createdAt` / `updatedAt`);
 *   `updatedAt` also backs the stale-replay reclaim window in the service layer.
 */
import { Schema, model, Document } from "mongoose";
import { WebhookDeliveryStatus } from "../types/webhook.types";
import type { IWebhookDelivery } from "../types/webhook.types";

export type WebhookDeliveryDocument = IWebhookDelivery & Document;

const ALL_STATUSES = Object.values(WebhookDeliveryStatus);

const WebhookDeliverySchema = new Schema<WebhookDeliveryDocument>(
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
        values: ALL_STATUSES,
        message: `status must be one of: ${ALL_STATUSES.join(", ")}`,
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
WebhookDeliverySchema.index({ webhookId: 1, _id: 1 });
WebhookDeliverySchema.index({ webhookId: 1, status: 1, updatedAt: -1 });

export const WebhookDeliveryModel = model<WebhookDeliveryDocument>(
  "WebhookDelivery",
  WebhookDeliverySchema
);
