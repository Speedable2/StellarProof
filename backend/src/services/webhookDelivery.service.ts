/**
 * WebhookDeliveryService – persistence + dispatch for outbound webhook
 * deliveries, and the replay pipeline for failed deliveries.
 *
 * Layering: Controller -> Service -> Model. The controller never touches the
 * database; this service owns all delivery state transitions; the
 * WebhookDelivery model owns storage.
 *
 * Replay contract (POST /api/v1/developer/webhooks/:id/deliveries/:deliveryId/replay):
 * - Only deliveries in the `failed` state may be replayed.
 * - The exact payload bytes and HMAC signature stored at dispatch time are
 *   re-sent verbatim; the signature is never recomputed, so receivers that
 *   captured the original signature keep validating it.
 * - The failed -> replaying transition is an atomic compare-and-swap, so two
 *   concurrent replay requests can never double-dispatch the same delivery.
 */
import { Types } from "mongoose";
import { StatusCodes } from "http-status-codes";
import { WebhookDeliveryModel } from "../models/WebhookDelivery.model";
import { WebhookDeliveryStatus } from "../types/webhook.types";
import type {
  CreateWebhookDeliveryDTO,
  IWebhookDelivery,
  ReplayWebhookDeliveryParams,
  ReplayWebhookDeliveryRequester,
  ReplayWebhookDeliveryResult,
} from "../types/webhook.types";
import { AppError } from "../errors/AppError";
import { computeHMAC } from "../utils/signature";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Signature/trace headers sent with every (re-)dispatch
// ---------------------------------------------------------------------------
export const WEBHOOK_SIGNATURE_HEADER = "x-stellarproof-signature";
export const WEBHOOK_EVENT_HEADER = "x-stellarproof-event";
export const WEBHOOK_ID_HEADER = "x-stellarproof-webhook-id";
export const WEBHOOK_DELIVERY_HEADER = "x-stellarproof-delivery-id";

/** Per-attempt timeout for a single webhook POST. */
const DISPATCH_TIMEOUT_MS = 10_000;

/** Outcome of a single HTTP dispatch attempt against the endpoint. */
export interface WebhookDispatchOutcome {
  delivered: boolean;
  responseStatus?: number;
  error?: string;
}

export class WebhookDeliveryService {
  constructor(private readonly timeoutMs: number = DISPATCH_TIMEOUT_MS) {}

  // -------------------------------------------------------------------------
  // Producer API – persist a delivery and run its initial dispatch
  // -------------------------------------------------------------------------

  /**
   * Persists a new delivery (with its HMAC-signed payload) and dispatches it
   * once. Automatic retry is intentionally manual-by-design: a failed
   * delivery can be re-dispatched through the replay endpoint.
   */
  async createAndDispatch(
    dto: CreateWebhookDeliveryDTO
  ): Promise<IWebhookDelivery> {
    const payloadString = JSON.stringify(dto.payload);
    const signature = computeHMAC(payloadString, dto.secret);

    const created = await WebhookDeliveryModel.create({
      webhookId: dto.webhookId,
      ...(dto.owner ? { owner: new Types.ObjectId(dto.owner) } : {}),
      event: dto.event,
      targetUrl: dto.targetUrl,
      payload: payloadString,
      signature,
      status: WebhookDeliveryStatus.PENDING,
      attempts: 0,
    });

    const outcome = await this.post(
      dto.targetUrl,
      payloadString,
      signature,
      dto.event,
      dto.webhookId,
      String(created._id)
    );

    const updated = await WebhookDeliveryModel.findByIdAndUpdate(
      created._id,
      {
        $set: {
          status: outcome.delivered
            ? WebhookDeliveryStatus.DELIVERED
            : WebhookDeliveryStatus.FAILED,
          attempts: 1,
          lastAttemptAt: new Date(),
          ...(outcome.delivered
            ? { deliveredAt: new Date(), lastError: undefined }
            : { lastError: outcome.error }),
          ...(outcome.responseStatus !== undefined
            ? { responseStatus: outcome.responseStatus }
            : {}),
        },
      },
      { new: true }
    ).lean<IWebhookDelivery>();

    return (updated ?? created.toObject()) as IWebhookDelivery;
  }

  // -------------------------------------------------------------------------
  // Replay API
  // -------------------------------------------------------------------------

  /**
   * Re-dispatches a failed delivery using its stored payload and signature.
   *
   * Flow: fetch + authorize -> validate replayable state -> atomic claim
   * (failed -> replaying) -> POST stored bytes -> persist final state.
   */
  async replayFailedDelivery(
    params: ReplayWebhookDeliveryParams,
    requester: ReplayWebhookDeliveryRequester
  ): Promise<ReplayWebhookDeliveryResult> {
    const { webhookId, deliveryId } = this.validateParams(params);

    // -- Fetch + authorize before touching state ----------------------------
    const delivery = await WebhookDeliveryModel.findOne({
      _id: deliveryId,
      webhookId,
    }).lean<IWebhookDelivery>();

    if (!delivery) {
      throw new AppError(
        `Webhook delivery '${deliveryId}' not found for webhook '${webhookId}'`,
        StatusCodes.NOT_FOUND,
        "DELIVERY_NOT_FOUND"
      );
    }

    this.assertCanReplay(delivery, requester);

    if (delivery.status !== WebhookDeliveryStatus.FAILED) {
      throw new AppError(
        `Only failed deliveries can be replayed; delivery '${deliveryId}' has status '${delivery.status}'`,
        StatusCodes.CONFLICT,
        "DELIVERY_NOT_REPLAYABLE"
      );
    }

    // -- Atomic claim: failed -> replaying (compare-and-swap) ---------------
    const claimed = await WebhookDeliveryModel.findOneAndUpdate(
      {
        _id: deliveryId,
        webhookId,
        status: WebhookDeliveryStatus.FAILED,
      },
      {
        $set: { status: WebhookDeliveryStatus.REPLAYING },
        $inc: { attempts: 1 },
      },
      { new: true }
    ).lean<IWebhookDelivery>();

    if (!claimed) {
      // Lost the race against a concurrent replay request.
      throw new AppError(
        `Delivery '${deliveryId}' is already being replayed`,
        StatusCodes.CONFLICT,
        "DELIVERY_ALREADY_REPLAYING"
      );
    }

    // -- Re-dispatch the stored payload with the stored signature ------------
    const outcome = await this.post(
      claimed.targetUrl,
      claimed.payload,
      claimed.signature,
      claimed.event,
      claimed.webhookId,
      String(claimed._id)
    );

    // -- Persist final state (payload/signature are never mutated) -----------
    const finalStatus = outcome.delivered
      ? WebhookDeliveryStatus.DELIVERED
      : WebhookDeliveryStatus.FAILED;

    const updated = await WebhookDeliveryModel.findOneAndUpdate(
      { _id: deliveryId, webhookId, status: WebhookDeliveryStatus.REPLAYING },
      {
        $set: {
          status: finalStatus,
          lastAttemptAt: new Date(),
          ...(outcome.delivered
            ? { deliveredAt: new Date() }
            : { lastError: outcome.error }),
          ...(outcome.responseStatus !== undefined
            ? { responseStatus: outcome.responseStatus }
            : {}),
        },
        ...(outcome.delivered ? { $unset: { lastError: 1 } } : {}),
      },
      { new: true }
    ).lean<IWebhookDelivery>();

    if (!updated) {
      // Defensive: the claim should still be held; surface a retryable error.
      throw new AppError(
        `Replay of delivery '${deliveryId}' completed but its final state could not be recorded`,
        StatusCodes.INTERNAL_SERVER_ERROR,
        "REPLAY_STATE_UPDATE_FAILED"
      );
    }

    logger.info("[WebhookDelivery] Replay finished", {
      deliveryId,
      webhookId,
      delivered: outcome.delivered,
      responseStatus: outcome.responseStatus,
      attempts: updated.attempts,
    });

    return {
      delivery: updated,
      delivered: outcome.delivered,
      ...(outcome.responseStatus !== undefined
        ? { responseStatus: outcome.responseStatus }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private validateParams(
    params: ReplayWebhookDeliveryParams
  ): ReplayWebhookDeliveryParams {
    const webhookId = params.webhookId?.trim();
    if (!webhookId || webhookId.length > 128) {
      throw new AppError(
        "webhookId must be between 1 and 128 characters",
        StatusCodes.BAD_REQUEST,
        "INVALID_WEBHOOK_ID"
      );
    }

    const deliveryId = params.deliveryId?.trim();
    if (!deliveryId || !Types.ObjectId.isValid(deliveryId)) {
      throw new AppError(
        "deliveryId must be a valid MongoDB ObjectId",
        StatusCodes.BAD_REQUEST,
        "INVALID_DELIVERY_ID"
      );
    }

    return { webhookId, deliveryId };
  }

  private assertCanReplay(
    delivery: IWebhookDelivery,
    requester: ReplayWebhookDeliveryRequester
  ): void {
    if (requester.role === "admin") return;

    const ownerId = delivery.owner ? String(delivery.owner) : undefined;
    if (!ownerId || ownerId !== requester.id) {
      throw new AppError(
        "You do not have permission to replay this webhook delivery",
        StatusCodes.FORBIDDEN,
        "DELIVERY_FORBIDDEN"
      );
    }
  }

  /** Single HTTP POST of the (stored) payload with the (stored) signature. */
  private async post(
    targetUrl: string,
    payload: string,
    signature: string,
    event: string,
    webhookId: string,
    deliveryId: string
  ): Promise<WebhookDispatchOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_EVENT_HEADER]: event,
          [WEBHOOK_ID_HEADER]: webhookId,
          [WEBHOOK_DELIVERY_HEADER]: deliveryId,
        },
        body: payload,
        signal: controller.signal,
      });

      if (response.ok) {
        return { delivered: true, responseStatus: response.status };
      }

      return {
        delivered: false,
        responseStatus: response.status,
        error: `Endpoint responded with status ${response.status}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        delivered: false,
        error: `Dispatch failed: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const webhookDeliveryService = new WebhookDeliveryService();
