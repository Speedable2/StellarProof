import { z } from 'zod';

/**
 * Validation schemas for Developer App and Webhook endpoints
 * Used with zodValidate middleware for request body validation
 */

// URL validation pattern (HTTP/HTTPS)
const URL_REGEX = /^https?:\/\/.+/;

/**
 * Schema for creating a new app
 * POST /api/v1/developer/apps
 */
export const createAppSchema = z.object({
  name: z
    .string()
    .min(1, 'App name cannot be empty')
    .max(255, 'App name cannot exceed 255 characters')
    .trim(),
  description: z
    .string()
    .max(1000, 'Description cannot exceed 1000 characters')
    .trim()
    .optional(),
});

/**
 * Schema for registering a webhook
 * POST /api/v1/developer/apps/:appId/webhooks
 */
export const registerWebhookSchema = z.object({
  url: z
    .string()
    .min(1, 'Webhook URL is required')
    .url('Webhook URL must be a valid URL')
    .regex(URL_REGEX, 'Webhook URL must be a valid HTTP/HTTPS URL'),
  events: z
    .array(z.string().min(1, 'Event name cannot be empty'))
    .min(1, 'At least one event must be specified')
    .nonempty('Events array cannot be empty'),
});

/**
 * Schema for app ID parameter validation
 */
export const appIdSchema = z.object({
  appId: z.string().min(1, 'App ID is required').trim(),
});
