import crypto from "crypto";
import User from "../models/User.model";
import WebhookDelivery, { type IWebhookDelivery } from "../models/WebhookDelivery.model";
import WebhookRegistration from "../models/WebhookRegistration.model";
import type { WebhookEvent, WebhookEventPayloadMap, WebhookEventType } from "../types/webhook.types";
import { decryptWebhookSecret } from "../utils/webhookSecrets";
import logger from "../utils/logger";

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const LOCK_DURATION_MS = 30_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const PAYLOAD_PREVIEW_LENGTH = 500;

export function createWebhookEvent<T extends WebhookEventType>(
  type: T,
  data: WebhookEventPayloadMap[T]
): WebhookEvent<T> {
  return { id: crypto.randomUUID(), type, occurredAt: new Date().toISOString(), data };
}

function responseError(responseCode: number): string {
  return `Webhook returned HTTP ${responseCode}`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 3 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

export class WebhookService {
  async enqueueForOwner<T extends WebhookEventType>(
    ownerId: string,
    event: WebhookEvent<T>
  ): Promise<number> {
    const registrations = await WebhookRegistration.find({
      ownerId,
      isActive: true,
      events: event.type,
    })
      .select("_id ownerId")
      .lean();
    if (registrations.length === 0) return 0;

    const serialized = JSON.stringify(event);
    const deliveries = registrations.map((registration) => ({
      registrationId: registration._id,
      ownerId: registration.ownerId,
      eventId: event.id,
      eventType: event.type,
      payload: event,
      payloadPreview: serialized.slice(0, PAYLOAD_PREVIEW_LENGTH),
      status: "pending" as const,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
    }));
    const result = await WebhookDelivery.bulkWrite(
      deliveries.map((delivery) => ({
        updateOne: {
          filter: { registrationId: delivery.registrationId, eventId: delivery.eventId },
          update: { $setOnInsert: delivery },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    return result.upsertedCount;
  }

  async enqueueForStellarPublicKey<T extends WebhookEventType>(
    ownerPublicKey: string,
    event: WebhookEvent<T>
  ): Promise<number> {
    const owner = await User.findOne({ stellarPublicKey: ownerPublicKey }).select("_id").lean();
    if (!owner) return 0;
    return this.enqueueForOwner(String(owner._id), event);
  }

  async processDueDeliveries(now = new Date()): Promise<number> {
    await WebhookDelivery.updateMany(
      {
        status: "processing",
        lockExpiresAt: { $lte: now },
        $expr: { $gte: ["$attempts", "$maxAttempts"] },
      },
      {
        $set: {
          status: "dead_letter",
          lastError: "Delivery worker stopped after the final attempt",
        },
        $unset: { lockExpiresAt: "" },
      }
    );
    let processed = 0;
    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const delivery = await this.claimDelivery(now);
      if (!delivery) break;
      await this.deliver(delivery, now);
      processed += 1;
    }
    return processed;
  }

  private claimDelivery(now: Date): Promise<IWebhookDelivery | null> {
    return WebhookDelivery.findOneAndUpdate(
      {
        $expr: { $lt: ["$attempts", "$maxAttempts"] },
        $or: [
          { status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: now } },
          { status: "processing", lockExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          lockExpiresAt: new Date(now.getTime() + LOCK_DURATION_MS),
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { createdAt: 1 } }
    ).exec();
  }

  private async deliver(delivery: IWebhookDelivery, now: Date): Promise<void> {
    const registration = await WebhookRegistration.findOne({
      _id: delivery.registrationId,
      ownerId: delivery.ownerId,
      isActive: true,
    }).select("+secretEncrypted url").exec();
    if (!registration) {
      await this.finish(delivery, {
        status: "dead_letter",
        lastError: "Webhook registration is missing or inactive",
      });
      return;
    }

    let secret: string;
    try {
      secret = decryptWebhookSecret(
        registration.secretEncrypted,
        String(registration.ownerId),
        String(registration._id)
      );
    } catch (error) {
      logger.error("Webhook secret could not be decrypted", {
        registrationId: String(registration._id),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.retryOrDeadLetter(delivery, now, "Webhook secret could not be decrypted");
      return;
    }

    const rawBody = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const digest = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const response = await fetch(registration.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StellarProof-Signature": `t=${timestamp},v1=${digest}`,
        },
        body: rawBody,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        await this.finish(delivery, {
          status: "delivered",
          responseCode: response.status,
          latencyMs,
          deliveredAt: new Date(),
        });
      } else {
        await this.retryOrDeadLetter(
          delivery,
          now,
          responseError(response.status),
          response.status,
          latencyMs
        );
      }
    } catch (error) {
      await this.retryOrDeadLetter(
        delivery,
        now,
        error instanceof Error ? error.message : String(error),
        undefined,
        Date.now() - startedAt
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async retryOrDeadLetter(
    delivery: IWebhookDelivery,
    now: Date,
    error: string,
    responseCode?: number,
    latencyMs?: number
  ): Promise<void> {
    if (delivery.attempts >= delivery.maxAttempts) {
      await this.finish(delivery, {
        status: "dead_letter",
        lastError: error,
        responseCode,
        latencyMs,
      });
      return;
    }
    await this.finish(delivery, {
      status: "failed",
      lastError: error,
      responseCode,
      latencyMs,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(delivery.attempts)),
    });
  }

  private async finish(
    delivery: IWebhookDelivery,
    update: Partial<
      Pick<
        IWebhookDelivery,
        "status" | "lastError" | "responseCode" | "latencyMs" | "deliveredAt" | "nextAttemptAt"
      >
    >
  ): Promise<void> {
    delivery.status = update.status ?? delivery.status;
    delivery.lastError = update.lastError;
    delivery.responseCode = update.responseCode;
    delivery.latencyMs = update.latencyMs;
    delivery.deliveredAt = update.deliveredAt;
    if (update.nextAttemptAt) delivery.nextAttemptAt = update.nextAttemptAt;
    delivery.set("lockExpiresAt", undefined);
    await delivery.save();
  }
}

export const webhookService = new WebhookService();
