/**
 * Liveness record of one verification worker process (collection
 * `workerHeartbeats`), upserted by the worker on every heartbeat.
 *
 * - `workerId` is unique: one document per worker process.
 * - `lastHeartbeatAt` is indexed so health checks can find live workers.
 */
import { Schema, model, type Document } from "mongoose";

export const WORKER_STATUSES = ["running", "stopping", "stopped"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface IWorkerHeartbeat extends Document {
  workerId: string;
  status: WorkerStatus;
  startedAt: Date;
  lastHeartbeatAt: Date;
  /** Ledger of the most recent mint this worker saw confirmed. */
  lastProcessedLedger?: number;
  processedCount: number;
  failedCount: number;
  /** Duration of the most recently finished request, in milliseconds. */
  lastProcessingMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

const WorkerHeartbeatSchema = new Schema<IWorkerHeartbeat>(
  {
    workerId: { type: String, required: true, unique: true, trim: true },
    status: { type: String, enum: WORKER_STATUSES, required: true },
    startedAt: { type: Date, required: true },
    lastHeartbeatAt: { type: Date, required: true, index: true },
    lastProcessedLedger: { type: Number, min: 0, default: undefined },
    processedCount: { type: Number, required: true, min: 0, default: 0 },
    failedCount: { type: Number, required: true, min: 0, default: 0 },
    lastProcessingMs: { type: Number, min: 0, default: undefined },
  },
  { timestamps: true, versionKey: false, collection: "workerHeartbeats" }
);

export const WorkerHeartbeatModel = model<IWorkerHeartbeat>("WorkerHeartbeat", WorkerHeartbeatSchema);
