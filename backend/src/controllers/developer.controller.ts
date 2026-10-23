import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { generateApiKeyForUser } from '../services/developer.service';
import { webhookDeliveryService } from '../services/webhookDelivery.service';
import { webhookSecretService } from '../services/webhookSecret.service';
import { AppError } from '../errors/AppError';
import type { IWebhookDelivery } from '../types/webhook.types';

/**
 * Legacy API key generation endpoint
 */
export const generateApiKey = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.body.userId || (req as any).user?.id;

    if (!userId) {
      res
        .status(401)
        .json({
          success: false,
          message: 'Unauthorized. User ID required.',
        });
      return;
    }

    const plainTextApiKey = await generateApiKeyForUser(userId);

    res.status(201).json({
      success: true,
      message: 'API key generated successfully.',
      key: plainTextApiKey,
    });
  } catch (error: any) {
    console.error('[API Key Error]', error);
    if (error.message === 'User not found') {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * Serializes a WebhookDelivery for API responses. The stored payload and
 * signature are included: they are the developer's own data and let the
 * consumer verify what was (and will be) sent on every attempt.
 */
function serializeDelivery(delivery: IWebhookDelivery): Record<string, unknown> {
  return {
    id: String(delivery._id),
    webhookId: delivery.webhookId,
    event: delivery.event,
    targetUrl: delivery.targetUrl,
    payload: delivery.payload,
    signature: delivery.signature,
    status: delivery.status,
    attempts: delivery.attempts,
    responseStatus: delivery.responseStatus ?? null,
    lastError: delivery.lastError ?? null,
    lastAttemptAt: delivery.lastAttemptAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    createdAt: delivery.createdAt ?? null,
    updatedAt: delivery.updatedAt ?? null,
  };
}

/**
 * POST /api/v1/developer/webhooks/:id/deliveries/:deliveryId/replay
 *
 * Re-dispatches a failed webhook delivery using the exact payload and HMAC
 * signature stored at dispatch time. Only deliveries in the `failed` state
 * are replayable; anything else yields 409 DELIVERY_NOT_REPLAYABLE.
 *
 * Auth: x-api-key header (verifyApiKey middleware populates req.user).
 * Ownership: only the delivery's owner (or an admin) may replay it.
 */
export const replayWebhookDelivery = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      throw new AppError(
        'Unauthorized. Authenticated developer required.',
        StatusCodes.UNAUTHORIZED,
        'AUTH_REQUIRED'
      );
    }

    const result = await webhookDeliveryService.replayFailedDelivery(
      { webhookId: req.params.id, deliveryId: req.params.deliveryId },
      { id: String(user._id), role: user.role }
    );

    res.status(StatusCodes.OK).json({
      success: true,
      message: result.delivered
        ? 'Webhook delivery replayed successfully.'
        : 'Webhook delivery replay attempted but the endpoint did not accept it.',
      data: {
        delivery: serializeDelivery(result.delivery),
        delivered: result.delivered,
        ...(result.responseStatus !== undefined
          ? { responseStatus: result.responseStatus }
          : {}),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Rotates a webhook HMAC secret and returns its plaintext exactly once. */
export const rotateWebhookSecret = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user;
    if (!user) throw new AppError('Unauthorized. Authenticated developer required.', StatusCodes.UNAUTHORIZED, 'AUTH_REQUIRED');
    const result = await webhookSecretService.rotateSecret(
      { webhookId: req.params.id, gracePeriodSeconds: req.body.gracePeriodSeconds },
      { id: String(user._id), role: user.role }
    );
    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Webhook secret rotated. Store this secret now; it will not be returned again.',
      data: {
        webhookId: result.webhookId,
        secret: result.secret,
        version: result.version,
        previousSecretValidUntil: result.previousSecretValidUntil.toISOString(),
      },
    });
  } catch (error) { next(error); }
};
