/**
 * Worker heartbeats and the health view built from them.
 *
 * Each worker upserts its own `workerHeartbeats` document on a fixed
 * interval. A worker is considered alive while it reports `running` and its
 * last heartbeat is newer than the staleness threshold; overall health is
 * `ok` while at least one worker is alive.
 */
import { WorkerHeartbeatModel, type WorkerStatus } from "../models/WorkerHeartbeat.model";

export interface HeartbeatUpdate {
  workerId: string;
  status: WorkerStatus;
  startedAt: Date;
  processedCount: number;
  failedCount: number;
  lastProcessedLedger?: number;
  lastProcessingMs?: number;
  now?: Date;
}

export interface WorkerHealthEntry {
  workerId: string;
  status: WorkerStatus;
  alive: boolean;
  startedAt: string;
  lastHeartbeatAt: string;
  lastProcessedLedger: number | null;
  processedCount: number;
  failedCount: number;
  lastProcessingMs: number | null;
}

export interface WorkerHealth {
  status: "ok" | "unavailable";
  aliveWorkers: number;
  staleAfterMs: number;
  checkedAt: string;
  workers: WorkerHealthEntry[];
}

interface HeartbeatRecord {
  workerId: string;
  status: WorkerStatus;
  startedAt: Date;
  lastHeartbeatAt: Date;
  lastProcessedLedger?: number;
  processedCount: number;
  failedCount: number;
  lastProcessingMs?: number;
}

/** Workers whose last heartbeat is older than this many staleness windows are not listed. */
const LISTED_WINDOWS = 10;

export class WorkerHeartbeatService {
  /** Records a heartbeat for one worker, creating its document on first use. */
  async beat(update: HeartbeatUpdate): Promise<void> {
    const { now = new Date(), lastProcessedLedger, lastProcessingMs, ...fields } = update;
    await WorkerHeartbeatModel.updateOne(
      { workerId: update.workerId },
      {
        $set: {
          ...fields,
          lastHeartbeatAt: now,
          ...(lastProcessedLedger !== undefined ? { lastProcessedLedger } : {}),
          ...(lastProcessingMs !== undefined ? { lastProcessingMs } : {}),
        },
      },
      { upsert: true }
    );
  }

  /**
   * Reports which workers are alive. Workers silent for much longer than the
   * staleness threshold are omitted so the list does not grow without bound.
   */
  async getHealth(staleAfterMs: number, now: Date = new Date()): Promise<WorkerHealth> {
    const listedSince = new Date(now.getTime() - staleAfterMs * LISTED_WINDOWS);
    const aliveSince = now.getTime() - staleAfterMs;

    const records = await WorkerHeartbeatModel.find({ lastHeartbeatAt: { $gte: listedSince } })
      .sort({ lastHeartbeatAt: -1 })
      .lean<HeartbeatRecord[]>();

    const workers = records.map((record): WorkerHealthEntry => ({
      workerId: record.workerId,
      status: record.status,
      alive: record.status === "running" && record.lastHeartbeatAt.getTime() >= aliveSince,
      startedAt: record.startedAt.toISOString(),
      lastHeartbeatAt: record.lastHeartbeatAt.toISOString(),
      lastProcessedLedger: record.lastProcessedLedger ?? null,
      processedCount: record.processedCount,
      failedCount: record.failedCount,
      lastProcessingMs: record.lastProcessingMs ?? null,
    }));
    const aliveWorkers = workers.filter((worker) => worker.alive).length;

    return {
      status: aliveWorkers > 0 ? "ok" : "unavailable",
      aliveWorkers,
      staleAfterMs,
      checkedAt: now.toISOString(),
      workers,
    };
  }
}

export const workerHeartbeatService = new WorkerHeartbeatService();
