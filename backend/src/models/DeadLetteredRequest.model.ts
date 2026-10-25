/**
 * Verification requests the worker gave up on (collection
 * `deadLetteredRequests`): retries were exhausted or the failure can never
 * succeed. Each document keeps enough of the request to inspect and replay it.
 *
 * - `eventId` is unique: a request is dead-lettered at most once.
 * - `deadLetteredAt` is indexed for newest-first operational queries.
 */
import { Schema, model, type Document, type Types } from "mongoose";

export interface IDeadLetteredRequest extends Document {
  eventId: string;
  requestEventId: Types.ObjectId;
  verificationJobId?: Types.ObjectId;
  mediaCid: string;
  manifestCid: string;
  requester: string;
  attempts: number;
  reason: string;
  /** Application error code of the final failure, when it had one. */
  errorCode?: string;
  /** Whether the final failure was transient (true when retries ran out). */
  retryable: boolean;
  workerId: string;
  deadLetteredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DeadLetteredRequestSchema = new Schema<IDeadLetteredRequest>(
  {
    eventId: { type: String, required: true, unique: true, trim: true },
    requestEventId: {
      type: Schema.Types.ObjectId,
      ref: "VerificationRequestEvent",
      required: true,
    },
    verificationJobId: {
      type: Schema.Types.ObjectId,
      ref: "VerificationJob",
      default: undefined,
    },
    mediaCid: { type: String, required: true },
    manifestCid: { type: String, required: true },
    requester: { type: String, required: true },
    attempts: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true },
    errorCode: { type: String, default: undefined },
    retryable: { type: Boolean, required: true },
    workerId: { type: String, required: true },
    deadLetteredAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, versionKey: false, collection: "deadLetteredRequests" }
);

export const DeadLetteredRequestModel = model<IDeadLetteredRequest>(
  "DeadLetteredRequest",
  DeadLetteredRequestSchema
);
