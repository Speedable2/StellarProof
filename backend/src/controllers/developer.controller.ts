import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { generateApiKeyForUser } from '../services/developer.service';
import { developerJobService } from '../services/developerJob.service';
import { apiKeyUsageService } from '../services/apiKeyUsage.service';
import { userService } from '../services/user.service';
import { createApp, registerWebhook, getAppDetails, listApps } from '../services/app.service';
import { webhookDeliveryService } from '../services/webhookDelivery.service';
import { webhookRegistrationService } from '../services/webhookRegistration.service';
import { webhookSecretService } from '../services/webhookSecret.service';
import { AppError } from '../errors/AppError';
import type { CreateAppDTO, RegisterWebhookDTO } from '../types/app.types';
import type {
  ListDeveloperJobsResponse,
  GetDeveloperJobResponse,
  UsageSummaryResponse,
  ValidatedListJobsQuery,
  ValidatedUsageSummaryQuery,
} from '../types/developer.types';
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
} from '../services/webhookRegistration.service';
import type { IWebhookRegistration } from '../models/WebhookRegistration.model';
import type { IWebhookDelivery } from '../types/webhook.types';

/** Helper to identify the authenticated requester's user id. */
function requireUserId(req: Request): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED, 'AUTH_REQUIRED');
  }
  return userId;
}

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
 * GET /api/v1/developer/api-keys/:keyId/usage
 * Retrieve aggregated API usage metrics for a specific API key.
 *
 * Authentication required. Caller must own the API key being queried.
 */
export const getApiKeyUsage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const keyId = req.params.keyId;
    const userId = req.user?._id?.toString();

    if (!userId) {
      next(new AppError('Authentication required', StatusCodes.UNAUTHORIZED, 'AUTHENTICATION_REQUIRED'));
      return;
    }

    if (!keyId) {
      next(new AppError('API key ID is required', StatusCodes.BAD_REQUEST, 'MISSING_KEY_ID'));
      return;
    }

    // Verify caller owns this API key (keyId is the hashed key).
    const user = await userService.getProfile(userId);
    if (!user) {
      next(new AppError('User not found', StatusCodes.NOT_FOUND, 'USER_NOT_FOUND'));
      return;
    }

    const ownsKey = user.apiKeys?.includes(keyId);
    if (!ownsKey) {
      // Return 404 to not leak information about which keys exist.
      next(new AppError('API key not found', StatusCodes.NOT_FOUND, 'API_KEY_NOT_FOUND'));
      return;
    }

    // Parse and validate query parameters.
    let from: Date | undefined;
    let to: Date | undefined;
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;
    const endpointParam = req.query.endpoint as string | undefined;
    const granularityParam = (req.query.granularity as string | undefined)?.toLowerCase();
    const limitParam = parseInt(req.query.limit as string, 10) || undefined;
    const skipParam = parseInt(req.query.skip as string, 10) || undefined;

    if (fromParam) {
      from = new Date(fromParam);
      if (isNaN(from.getTime())) {
        next(new AppError('Invalid "from" date format', StatusCodes.BAD_REQUEST, 'INVALID_FROM_DATE'));
        return;
      }
    }

    if (toParam) {
      to = new Date(toParam);
      if (isNaN(to.getTime())) {
        next(new AppError('Invalid "to" date format', StatusCodes.BAD_REQUEST, 'INVALID_TO_DATE'));
        return;
      }
    }

    if (granularityParam && !['hour', 'day'].includes(granularityParam)) {
      next(new AppError('Granularity must be "hour" or "day"', StatusCodes.BAD_REQUEST, 'INVALID_GRANULARITY'));
      return;
    }

    if (limitParam !== undefined && (limitParam < 1 || limitParam > 10000)) {
      next(new AppError('Limit must be between 1 and 10000', StatusCodes.BAD_REQUEST, 'INVALID_LIMIT'));
      return;
    }

    if (skipParam !== undefined && skipParam < 0) {
      next(new AppError('Skip must be non-negative', StatusCodes.BAD_REQUEST, 'INVALID_SKIP'));
      return;
    }

    const usage = await apiKeyUsageService.getUsageByKey(keyId, {
      from,
      to,
      endpoint: endpointParam,
      granularity: (granularityParam as 'hour' | 'day') || 'hour',
      limit: limitParam,
      skip: skipParam,
    });

    res.status(StatusCodes.OK).json({
      success: true,
      data: usage,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new app for a developer
 * @route POST /api/v1/developer/apps
 */
export const createDeveloperApp = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      throw new AppError('Unauthorized. User ID required.', StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED');
    }

    const dto: CreateAppDTO = {
      name: req.body.name,
      description: req.body.description,
    };

    const app = await createApp(userId, dto);

    res.status(StatusCodes.CREATED).json({
      success: true,
      data: app,
      message: 'App created successfully.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List all apps for a developer
 * @route GET /api/v1/developer/apps
 */
export const listDeveloperApps = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      throw new AppError('Unauthorized. User ID required.', StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED');
    }

    const apps = await listApps(userId);

    res.status(StatusCodes.OK).json({
      success: true,
      data: apps,
      message: 'Apps retrieved successfully.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get app details with webhooks
 * @route GET /api/v1/developer/apps/:appId
 */
export const getAppDetailsController = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const appId = req.params.appId;

    if (!userId) {
      throw new AppError('Unauthorized. User ID required.', StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED');
    }

    if (!appId) {
      throw new AppError('App ID is required', StatusCodes.BAD_REQUEST, 'MISSING_APP_ID');
    }

    const appDetails = await getAppDetails(userId, appId);

    res.status(StatusCodes.OK).json({
      success: true,
      data: appDetails,
      message: 'App details retrieved successfully.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Register a webhook for an app
 * @route POST /api/v1/developer/apps/:appId/webhooks
 * @returns Generated webhook with HMAC secret
 */
export const registerAppWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const appId = req.params.appId;

    if (!userId) {
      throw new AppError('Unauthorized. User ID required.', StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED');
    }

    if (!appId) {
      throw new AppError('App ID is required', StatusCodes.BAD_REQUEST, 'MISSING_APP_ID');
    }

    const dto: RegisterWebhookDTO = {
      url: req.body.url,
      events: req.body.events,
    };

    const webhook = await registerWebhook(userId, appId, dto);

    res.status(StatusCodes.CREATED).json({
      success: true,
      data: webhook,
      message: 'Webhook registered successfully. Store the secret securely.',
    });
  } catch (error) {
    next(error);
  }
};

function requesterId(req: Request): string {
  if (!req.user) throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  return String(req.user._id);
}

function registrationResponse(registration: IWebhookRegistration) {
  return {
    id: String(registration._id),
    url: registration.url,
    events: registration.events,
    isActive: registration.isActive,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  };
}

/**
 * POST /api/v1/developer/webhooks
 * Register a new webhook endpoint for the authenticated developer.
 */
export const createWebhookRegistration = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await webhookRegistrationService.create(
      requesterId(req),
      req.body as CreateWebhookInput
    );
    res.status(StatusCodes.CREATED).json({
      success: true,
      data: { ...registrationResponse(result.registration), secret: result.secret },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/developer/webhooks
 * List the authenticated developer's webhook registrations.
 */
export const listWebhookRegistrations = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const registrations = await webhookRegistrationService.list(requesterId(req));
    res.status(StatusCodes.OK).json({ success: true, data: registrations.map(registrationResponse) });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/v1/developer/webhooks/:id
 * Update a webhook registration owned by the authenticated developer.
 */
export const updateWebhookRegistration = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const registration = await webhookRegistrationService.update(
      requesterId(req),
      req.params.id,
      req.body as UpdateWebhookInput
    );
    res.status(StatusCodes.OK).json({ success: true, data: registrationResponse(registration) });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/developer/webhooks/:id
 * Delete a webhook registration owned by the authenticated developer.
 */
export const deleteWebhookRegistration = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await webhookRegistrationService.remove(requesterId(req), req.params.id);
    res.status(StatusCodes.OK).json({ success: true, data: { id: req.params.id, deleted: true } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/developer/webhooks/:id/deliveries
 * List queued webhook deliveries for a registration owned by the developer.
 */
export const listWebhookDeliveries = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { limit, skip } = res.locals.deliveryPagination as { limit: number; skip: number };
    const result = await webhookDeliveryService.listForRegistration(
      requesterId(req),
      req.params.id,
      limit,
      skip
    );
    res.status(StatusCodes.OK).json({
      success: true,
      data: result.deliveries,
      total: result.total,
      limit,
      skip,
    });
  } catch (error) {
    next(error);
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

/**
 * Developer controller with class-based handlers
 */
class DeveloperController {
  /**
   * GET /api/v1/developer/jobs
   *
   * List jobs across all of the developer's apps
   * with filters, pagination, and sorting.
   */
  async listJobs(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Extract authenticated developer
      const user = (req as any).user;
      if (!user || !user.stellarPublicKey || !user._id) {
        throw new AppError(
          'Unauthorized',
          StatusCodes.UNAUTHORIZED,
          'UNAUTHORIZED'
        );
      }

      // Parse and validate query parameters
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string) || 20));
      const status = req.query.status as string | undefined;
      const appId = req.query.appId as string | undefined;
      const jobType = req.query.jobType as string | undefined;
      const createdFrom = req.query.createdFrom as string | undefined;
      const createdTo = req.query.createdTo as string | undefined;
      const sortBy = (req.query.sortBy as string) || 'createdAt';
      const sortOrder = (req.query.sortOrder as string) || 'desc';

      // Validate status if provided
      if (status && !isValidStatus(status)) {
        throw new AppError(
          'Invalid status value',
          StatusCodes.BAD_REQUEST,
          'INVALID_STATUS'
        );
      }

      // Validate date parameters
      let createdFromDate: Date | undefined;
      let createdToDate: Date | undefined;

      if (createdFrom) {
        createdFromDate = new Date(createdFrom);
        if (isNaN(createdFromDate.getTime())) {
          throw new AppError(
            'Invalid createdFrom date',
            StatusCodes.BAD_REQUEST,
            'INVALID_DATE'
          );
        }
      }

      if (createdTo) {
        createdToDate = new Date(createdTo);
        if (isNaN(createdToDate.getTime())) {
          throw new AppError(
            'Invalid createdTo date',
            StatusCodes.BAD_REQUEST,
            'INVALID_DATE'
          );
        }
      }

      if (createdFromDate && createdToDate && createdFromDate > createdToDate) {
        throw new AppError(
          'createdFrom must be before createdTo',
          StatusCodes.BAD_REQUEST,
          'INVALID_DATE_RANGE'
        );
      }

      // Build validated query
      const query: ValidatedListJobsQuery = {
        status: status as any,
        appId,
        jobType,
        createdFrom: createdFromDate,
        createdTo: createdToDate,
        sortBy: sortBy as any,
        sortOrder: sortOrder as any,
        page,
        limit,
      };

      // Call service
      const result = await developerJobService.listJobs(
        user._id.toString(),
        user.stellarPublicKey,
        query
      );

      // Format response
      const response: ListDeveloperJobsResponse = {
        success: true,
        data: result.items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      };

      res.status(StatusCodes.OK).json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/developer/jobs/:id
   *
   * Retrieve a single job by ID with full details,
   * verifying the developer owns it.
   */
  async getJobById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Extract authenticated developer
      const user = (req as any).user;
      if (!user || !user.stellarPublicKey || !user._id) {
        throw new AppError(
          'Unauthorized',
          StatusCodes.UNAUTHORIZED,
          'UNAUTHORIZED'
        );
      }

      const jobId = req.params.id;

      // Call service (will throw 400 or 404 as needed)
      const job = await developerJobService.getJobById(
        user._id.toString(),
        user.stellarPublicKey,
        jobId
      );

      const response: GetDeveloperJobResponse = {
        success: true,
        data: job,
      };

      res.status(StatusCodes.OK).json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/developer/usage/summary
   *
   * Retrieve usage summary for the developer
   * with status counts and per-app breakdown
   * over a specified date range.
   */
  async getUsageSummary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Extract authenticated developer
      const user = (req as any).user;
      if (!user || !user.stellarPublicKey || !user._id) {
        throw new AppError(
          'Unauthorized',
          StatusCodes.UNAUTHORIZED,
          'UNAUTHORIZED'
        );
      }

      // Parse and validate query parameters
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;

      // Default date range: last 30 days
      const now = new Date();
      const toDate = to ? new Date(to) : now;
      const fromDate = from
        ? new Date(from)
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Validate dates
      if (isNaN(fromDate.getTime())) {
        throw new AppError(
          'Invalid from date',
          StatusCodes.BAD_REQUEST,
          'INVALID_DATE'
        );
      }

      if (isNaN(toDate.getTime())) {
        throw new AppError(
          'Invalid to date',
          StatusCodes.BAD_REQUEST,
          'INVALID_DATE'
        );
      }

      if (fromDate > toDate) {
        throw new AppError(
          'from date must be before to date',
          StatusCodes.BAD_REQUEST,
          'INVALID_DATE_RANGE'
        );
      }

      // Build validated query
      const query: ValidatedUsageSummaryQuery = {
        from: fromDate,
        to: toDate,
      };

      // Call service
      const result = await developerJobService.getUsageSummary(
        user._id.toString(),
        user.stellarPublicKey,
        query
      );

      const response: UsageSummaryResponse = {
        success: true,
        data: {
          period: result.period,
          totalJobs: result.totalJobs,
          statusCounts: result.statusCounts,
          successRate: result.successRate,
          apps: result.apps,
        },
      };

      res.status(StatusCodes.OK).json(response);
    } catch (err) {
      next(err);
    }
  }
}

// Helper function to validate status
function isValidStatus(status: string): boolean {
  const validStatuses = [
    'pending',
    'processing',
    'tee_verifying',
    'minting',
    'completed',
    'failed',
  ];
  return validStatuses.includes(status);
}

export const developerController = new DeveloperController();
