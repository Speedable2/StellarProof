import crypto from "crypto";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import { IWebhookSecret, WebhookSecretModel } from "../models/WebhookSecret.model";

const DEFAULT_GRACE_SECONDS = 3_600;
const MAX_GRACE_SECONDS = 7 * 24 * 60 * 60;

export interface RotateWebhookSecretParams { webhookId: string; gracePeriodSeconds?: number; }
export interface WebhookSecretRequester { id: string; role: "creator" | "developer" | "admin"; }
export interface RotateWebhookSecretResult { webhookId: string; secret: string; version: number; previousSecretValidUntil: Date; }

export class WebhookSecretService {
  async rotateSecret(params: RotateWebhookSecretParams, requester: WebhookSecretRequester): Promise<RotateWebhookSecretResult> {
    const webhookId = params.webhookId?.trim();
    if (!webhookId || webhookId.length > 128) throw new AppError("webhookId must be between 1 and 128 characters", StatusCodes.BAD_REQUEST, "INVALID_WEBHOOK_ID");
    const gracePeriodSeconds = params.gracePeriodSeconds ?? DEFAULT_GRACE_SECONDS;
    if (!Number.isSafeInteger(gracePeriodSeconds) || gracePeriodSeconds < 0 || gracePeriodSeconds > MAX_GRACE_SECONDS) {
      throw new AppError(`gracePeriodSeconds must be an integer between 0 and ${MAX_GRACE_SECONDS}`, StatusCodes.BAD_REQUEST, "INVALID_GRACE_PERIOD");
    }

    const current = await WebhookSecretModel.findOne({ webhookId }).select("+encryptedSecret +iv +authTag").lean<IWebhookSecret>();
    if (!current) throw new AppError("Webhook secret configuration not found", StatusCodes.NOT_FOUND, "WEBHOOK_SECRET_NOT_FOUND");
    if (requester.role !== "admin" && (!current.owner || String(current.owner) !== requester.id)) {
      throw new AppError("You do not have permission to rotate this webhook secret", StatusCodes.FORBIDDEN, "WEBHOOK_SECRET_FORBIDDEN");
    }

    const secret = crypto.randomBytes(32).toString("base64url");
    const iv = crypto.randomBytes(12);
    // Resolve configuration only when rotation is invoked; route/schema imports
    // must remain side-effect free for tooling and test discovery.
    const { env } = require("../config/env") as typeof import("../config/env");
    const key = crypto.createHash("sha256").update(env.MASTER_KEY, "utf8").digest();
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encryptedSecret = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]).toString("base64");
    const previousSecretValidUntil = new Date(Date.now() + gracePeriodSeconds * 1_000);
    const updated = await WebhookSecretModel.findOneAndUpdate(
      { _id: current._id, version: current.version },
      { $set: { encryptedSecret, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), previousSecretValidUntil }, $inc: { version: 1 } },
      { new: true }
    ).lean<IWebhookSecret>();
    if (!updated) throw new AppError("Webhook secret changed concurrently; retry the rotation", StatusCodes.CONFLICT, "WEBHOOK_SECRET_ROTATION_CONFLICT");
    return { webhookId: updated.webhookId, secret, version: updated.version, previousSecretValidUntil };
  }
}

export const webhookSecretService = new WebhookSecretService();
