import { Document, model, Schema } from "mongoose";

export interface IWebhookSecret {
  _id?: Schema.Types.ObjectId;
  webhookId: string;
  owner?: Schema.Types.ObjectId;
  encryptedSecret: string;
  iv: string;
  authTag: string;
  version: number;
  previousSecretValidUntil?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WebhookSecretDocument = IWebhookSecret & Document;

const WebhookSecretSchema = new Schema<WebhookSecretDocument>({
  webhookId: { type: String, required: true, trim: true, unique: true, index: true },
  owner: { type: Schema.Types.ObjectId, ref: "User", index: true, default: undefined },
  encryptedSecret: { type: String, required: true, select: false },
  iv: { type: String, required: true, select: false },
  authTag: { type: String, required: true, select: false },
  version: { type: Number, required: true, min: 1, default: 1 },
  previousSecretValidUntil: { type: Date, default: undefined },
}, { timestamps: true, versionKey: false });

export const WebhookSecretModel = model<WebhookSecretDocument>("WebhookSecret", WebhookSecretSchema);
