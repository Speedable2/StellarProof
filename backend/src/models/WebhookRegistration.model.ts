import mongoose, { Document, Schema } from 'mongoose';
import { VerificationWebhookEvent } from '../types/verification.types';

export interface IWebhookRegistration extends Document {
  ownerId: mongoose.Types.ObjectId;
  url: string;
  events: VerificationWebhookEvent[];
  secretEncrypted: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WebhookRegistrationSchema = new Schema<IWebhookRegistration>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    events: { type: [String], required: true, enum: Object.values(VerificationWebhookEvent) },
    secretEncrypted: { type: String, required: true, select: false },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

WebhookRegistrationSchema.index({ ownerId: 1, url: 1 }, { unique: true });

export default mongoose.models.WebhookRegistration as mongoose.Model<IWebhookRegistration> ||
  mongoose.model<IWebhookRegistration>('WebhookRegistration', WebhookRegistrationSchema);
