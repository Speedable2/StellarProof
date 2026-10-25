import mongoose, { Schema, Document } from 'mongoose';
import * as crypto from 'crypto';

/**
 * AppWebhook Interface
 * Represents a webhook subscription tied to a developer's app.
 */
export interface IAppWebhook {
  /** Unique identifier for the webhook */
  id: string;
  /** The webhook endpoint URL where events will be sent */
  url: string;
  /** Array of events this webhook is subscribed to */
  events: string[];
  /** HMAC secret for verifying webhook payloads */
  secret: string;
  /** Whether the webhook is active */
  isActive: boolean;
  /** When the webhook was created */
  createdAt: Date;
  /** When the webhook was last updated */
  updatedAt: Date;
}

/**
 * App Interface
 * Represents a developer application that can subscribe to webhook events.
 */
export interface IApp extends Document {
  /** Reference to the developer/user who owns this app */
  userId: mongoose.Types.ObjectId;
  /** User-friendly name for the app */
  name: string;
  /** Optional description of what the app does */
  description?: string;
  /** Array of webhooks registered for this app */
  webhooks: IAppWebhook[];
  /** Whether the app is active */
  isActive: boolean;
  /** When the app was created */
  createdAt: Date;
  /** When the app was last updated */
  updatedAt: Date;
}

const AppWebhookSchema = new Schema<IAppWebhook>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    url: {
      type: String,
      required: [true, 'Webhook URL is required'],
      match: [
        /^https?:\/\/.+/,
        'Webhook URL must be a valid HTTP/HTTPS URL',
      ],
    },
    events: {
      type: [String],
      required: [true, 'At least one event must be specified'],
      validate: {
        validator: (v: string[]) => v.length > 0,
        message: 'Events array cannot be empty',
      },
    },
    secret: {
      type: String,
      required: [true, 'HMAC secret is required'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const AppSchema = new Schema<IApp>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'App name is required'],
      trim: true,
      maxlength: [255, 'App name cannot exceed 255 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    webhooks: [AppWebhookSchema],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Ensure compound uniqueness: userId + name for apps
AppSchema.index({ userId: 1, name: 1 }, { unique: true });

export default mongoose.model<IApp>('App', AppSchema);
