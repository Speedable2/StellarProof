import crypto from 'crypto';
import mongoose from 'mongoose';
import WebhookRegistration, { type IWebhookRegistration } from '../models/WebhookRegistration.model';
import { VerificationWebhookEvent } from '../types/verification.types';
import { AppError } from '../errors/AppError';

export interface CreateWebhookInput {
  url: string;
  events: VerificationWebhookEvent[];
}

export interface UpdateWebhookInput {
  url?: string;
  events?: VerificationWebhookEvent[];
  isActive?: boolean;
}

export interface CreatedWebhookRegistration {
  registration: IWebhookRegistration;
  secret: string;
}

export class WebhookRegistrationError extends AppError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode, 'WEBHOOK_REGISTRATION_ERROR');
  }
}

function validateUrl(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebhookRegistrationError('A valid webhook URL is required', 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebhookRegistrationError('A valid webhook URL is required', 400);
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hostname === '') {
    throw new WebhookRegistrationError('Webhook URL must use HTTP or HTTPS and cannot contain credentials', 400);
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new WebhookRegistrationError('Webhook URL must use HTTPS in production', 400);
  }
  return parsed.toString();
}

function validateEvents(events: unknown): VerificationWebhookEvent[] {
  const allowed = new Set<string>(Object.values(VerificationWebhookEvent));
  if (!Array.isArray(events) || events.length === 0 || events.some((event) => typeof event !== 'string' || !allowed.has(event))) {
    throw new WebhookRegistrationError('At least one supported webhook event is required', 400);
  }
  return [...new Set(events)] as VerificationWebhookEvent[];
}

function encryptWebhookSecret(secret: string): string {
  const encryptionKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!encryptionKey || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new AppError('WEBHOOK_SECRET_ENCRYPTION_KEY must be configured as a 64-character hex key', 500, 'WEBHOOK_SECRET_CONFIG_INVALID');
  }
  const key = crypto.createHash('sha256').update('stellarproof:webhook-secret:v1\0').update(Buffer.from(encryptionKey, 'hex')).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('base64')}`;
}

function assertObjectId(value: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new WebhookRegistrationError('Invalid webhook registration ID', 400);
  return new mongoose.Types.ObjectId(value);
}

export class WebhookRegistrationService {
  async create(ownerId: string, input: CreateWebhookInput): Promise<CreatedWebhookRegistration> {
    if (!mongoose.Types.ObjectId.isValid(ownerId)) throw new WebhookRegistrationError('Invalid owner ID', 400);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new WebhookRegistrationError('Webhook registration details are required', 400);
    }
    const url = validateUrl(input.url);
    const events = validateEvents(input.events);
    const existing = await WebhookRegistration.exists({ ownerId, url });
    if (existing) throw new WebhookRegistrationError('A webhook for this URL is already registered', 409);
    const secret = crypto.randomBytes(32).toString('hex');
    const registration = await WebhookRegistration.create({
      ownerId,
      url,
      events,
      secretEncrypted: encryptWebhookSecret(secret),
      isActive: true,
    });
    return { registration, secret };
  }

  list(ownerId: string): Promise<IWebhookRegistration[]> {
    return WebhookRegistration.find({ ownerId }).sort({ createdAt: -1 }).exec();
  }

  async update(ownerId: string, registrationId: string, input: UpdateWebhookInput): Promise<IWebhookRegistration> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new WebhookRegistrationError('Webhook update details are required', 400);
    }
    const update: Partial<Pick<IWebhookRegistration, 'url' | 'events' | 'isActive'>> = {};
    if (input.url !== undefined) update.url = validateUrl(input.url);
    if (input.events !== undefined) update.events = validateEvents(input.events);
    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') throw new WebhookRegistrationError('isActive must be a boolean', 400);
      update.isActive = input.isActive;
    }
    if (Object.keys(update).length === 0) throw new WebhookRegistrationError('At least one updatable field is required', 400);
    const result = await WebhookRegistration.findOneAndUpdate(
      { _id: assertObjectId(registrationId), ownerId },
      { $set: update },
      { new: true, runValidators: true }
    ).exec();
    if (!result) throw new WebhookRegistrationError('Webhook registration not found', 404);
    return result;
  }

  async remove(ownerId: string, registrationId: string): Promise<void> {
    const result = await WebhookRegistration.deleteOne({ _id: assertObjectId(registrationId), ownerId }).exec();
    if (result.deletedCount === 0) throw new WebhookRegistrationError('Webhook registration not found', 404);
  }
}

export const webhookRegistrationService = new WebhookRegistrationService();
