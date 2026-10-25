import * as crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import App, { IApp, IAppWebhook } from '../models/App.model';
import { AppError } from '../errors/AppError';
import { RegisterWebhookDTO, CreateAppDTO, WebhookRegistrationResponse, CreateAppResponse, AppDetailsResponse, WebhookSummary } from '../types/app.types';

/**
 * Generates a random HMAC secret for webhook verification
 * @returns hex-encoded 32-byte secret
 */
function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates a unique webhook ID
 * @returns unique webhook identifier
 */
function generateWebhookId(): string {
  return `wh_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Create a new app for a user
 * @param userId - The user ID creating the app
 * @param dto - CreateAppDTO with app name and optional description
 * @returns Created app response
 */
export async function createApp(userId: string, dto: CreateAppDTO): Promise<CreateAppResponse> {
  if (!userId) {
    throw new AppError('User ID is required', StatusCodes.BAD_REQUEST, 'MISSING_USER_ID');
  }

  if (!dto.name || typeof dto.name !== 'string' || dto.name.trim().length === 0) {
    throw new AppError('App name is required and must be a non-empty string', StatusCodes.BAD_REQUEST, 'INVALID_APP_NAME');
  }

  try {
    // Check if app with this name already exists for this user
    const existingApp = await App.findOne({
      userId,
      name: dto.name.trim(),
    });

    if (existingApp) {
      throw new AppError(
        `App with name "${dto.name}" already exists for this user`,
        StatusCodes.CONFLICT,
        'APP_NAME_EXISTS'
      );
    }

    const newApp = await App.create({
      userId,
      name: dto.name.trim(),
      description: dto.description?.trim() || undefined,
      webhooks: [],
      isActive: true,
    });

    return {
      id: newApp._id.toString(),
      userId: newApp.userId.toString(),
      name: newApp.name,
      description: newApp.description,
      isActive: newApp.isActive,
      createdAt: newApp.createdAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'Failed to create app',
      StatusCodes.INTERNAL_SERVER_ERROR,
      'APP_CREATION_FAILED'
    );
  }
}

/**
 * Register a webhook for an app
 * @param userId - The user ID (for authorization)
 * @param appId - The app ID to register the webhook for
 * @param dto - RegisterWebhookDTO with URL and events
 * @returns WebhookRegistrationResponse with generated secret
 */
export async function registerWebhook(
  userId: string,
  appId: string,
  dto: RegisterWebhookDTO
): Promise<WebhookRegistrationResponse> {
  if (!userId) {
    throw new AppError('User ID is required', StatusCodes.BAD_REQUEST, 'MISSING_USER_ID');
  }

  if (!appId) {
    throw new AppError('App ID is required', StatusCodes.BAD_REQUEST, 'MISSING_APP_ID');
  }

  // Validate URL
  if (!dto.url || typeof dto.url !== 'string') {
    throw new AppError('Webhook URL is required', StatusCodes.BAD_REQUEST, 'INVALID_WEBHOOK_URL');
  }

  try {
    new URL(dto.url);
  } catch {
    throw new AppError('Webhook URL must be a valid HTTP/HTTPS URL', StatusCodes.BAD_REQUEST, 'INVALID_WEBHOOK_URL');
  }

  // Validate events
  if (!Array.isArray(dto.events) || dto.events.length === 0) {
    throw new AppError('At least one event must be specified', StatusCodes.BAD_REQUEST, 'INVALID_EVENTS');
  }

  try {
    // Find app and verify ownership
    const app = await App.findById(appId);

    if (!app) {
      throw new AppError('App not found', StatusCodes.NOT_FOUND, 'APP_NOT_FOUND');
    }

    // Verify user owns this app
    if (app.userId.toString() !== userId) {
      throw new AppError(
        'You do not have permission to modify this app',
        StatusCodes.FORBIDDEN,
        'APP_FORBIDDEN'
      );
    }

    if (!app.isActive) {
      throw new AppError('Cannot register webhooks for an inactive app', StatusCodes.BAD_REQUEST, 'APP_INACTIVE');
    }

    // Generate webhook credentials
    const webhookId = generateWebhookId();
    const secret = generateWebhookSecret();

    // Create webhook object
    const webhook: IAppWebhook = {
      id: webhookId,
      url: dto.url.trim(),
      events: Array.isArray(dto.events) ? dto.events : [],
      secret,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add webhook to app
    app.webhooks.push(webhook);
    await app.save();

    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret, // Only returned once at registration
      createdAt: webhook.createdAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'Failed to register webhook',
      StatusCodes.INTERNAL_SERVER_ERROR,
      'WEBHOOK_REGISTRATION_FAILED'
    );
  }
}

/**
 * Get app details with webhooks (secrets excluded)
 * @param userId - The user ID (for authorization)
 * @param appId - The app ID to retrieve
 * @returns AppDetailsResponse with webhook summaries
 */
export async function getAppDetails(userId: string, appId: string): Promise<AppDetailsResponse> {
  if (!userId) {
    throw new AppError('User ID is required', StatusCodes.BAD_REQUEST, 'MISSING_USER_ID');
  }

  if (!appId) {
    throw new AppError('App ID is required', StatusCodes.BAD_REQUEST, 'MISSING_APP_ID');
  }

  try {
    const app = await App.findById(appId);

    if (!app) {
      throw new AppError('App not found', StatusCodes.NOT_FOUND, 'APP_NOT_FOUND');
    }

    // Verify user owns this app
    if (app.userId.toString() !== userId) {
      throw new AppError(
        'You do not have permission to access this app',
        StatusCodes.FORBIDDEN,
        'APP_FORBIDDEN'
      );
    }

    // Build webhook summaries without secrets
    const webhooks: WebhookSummary[] = app.webhooks.map((webhook) => ({
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt.toISOString(),
      updatedAt: webhook.updatedAt.toISOString(),
    }));

    return {
      id: app._id.toString(),
      userId: app.userId.toString(),
      name: app.name,
      description: app.description,
      webhooks,
      isActive: app.isActive,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'Failed to retrieve app details',
      StatusCodes.INTERNAL_SERVER_ERROR,
      'GET_APP_FAILED'
    );
  }
}

/**
 * List all apps for a user
 * @param userId - The user ID
 * @returns Array of app summaries
 */
export async function listApps(userId: string): Promise<CreateAppResponse[]> {
  if (!userId) {
    throw new AppError('User ID is required', StatusCodes.BAD_REQUEST, 'MISSING_USER_ID');
  }

  try {
    const apps = await App.find({ userId }).sort({ createdAt: -1 });

    return apps.map((app) => ({
      id: app._id.toString(),
      userId: app.userId.toString(),
      name: app.name,
      description: app.description,
      isActive: app.isActive,
      createdAt: app.createdAt.toISOString(),
    }));
  } catch (error) {
    throw new AppError(
      'Failed to list apps',
      StatusCodes.INTERNAL_SERVER_ERROR,
      'LIST_APPS_FAILED'
    );
  }
}
