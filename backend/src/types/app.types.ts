/**
 * Type definitions for Developer App and Webhook management.
 * Used across models, services, controllers, and routes.
 */

/**
 * Webhook event types that developers can subscribe to
 */
export enum WebhookEventType {
  VERIFICATION_COMPLETED = 'verification.completed',
  VERIFICATION_FAILED = 'verification.failed',
  CERTIFICATE_MINTED = 'certificate.minted',
}

/**
 * Request DTO for registering a webhook
 */
export interface RegisterWebhookDTO {
  /** The webhook endpoint URL */
  url: string;
  /** Array of events to subscribe to */
  events: WebhookEventType[] | string[];
}

/**
 * Response DTO for webhook registration
 */
export interface WebhookRegistrationResponse {
  /** Unique webhook identifier */
  id: string;
  /** The webhook URL */
  url: string;
  /** Subscribed events */
  events: string[];
  /** HMAC secret for payload verification (only returned once at registration) */
  secret: string;
  /** Webhook creation timestamp */
  createdAt: string;
}

/**
 * Request DTO for creating an app
 */
export interface CreateAppDTO {
  /** App name */
  name: string;
  /** Optional app description */
  description?: string;
}

/**
 * Response DTO for app creation
 */
export interface CreateAppResponse {
  /** App ID */
  id: string;
  /** User ID */
  userId: string;
  /** App name */
  name: string;
  /** App description */
  description?: string;
  /** Whether the app is active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Response DTO for app details with webhooks
 */
export interface AppDetailsResponse {
  /** App ID */
  id: string;
  /** User ID */
  userId: string;
  /** App name */
  name: string;
  /** App description */
  description?: string;
  /** Array of registered webhooks (without secrets) */
  webhooks: WebhookSummary[];
  /** Whether the app is active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Webhook summary (without secret)
 */
export interface WebhookSummary {
  /** Webhook ID */
  id: string;
  /** Webhook URL */
  url: string;
  /** Subscribed events */
  events: string[];
  /** Whether the webhook is active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  message?: string;
}
