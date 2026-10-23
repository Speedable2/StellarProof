import type { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import { workerHeartbeatService } from "../services/workerHeartbeat.service";

/** Staleness threshold, read lazily so importing the controller never requires env. */
function staleAfterMs(): number {
  const { env } = require("../config/env") as typeof import("../config/env");
  return env.WORKER_HEARTBEAT_STALE_MS;
}

export class WorkerController {
  /**
   * GET /api/v1/worker/health
   * Liveness of the verification workers from their heartbeats: 200 while at
   * least one worker is alive, 503 otherwise.
   */
  async getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const health = await workerHeartbeatService.getHealth(staleAfterMs());
      res
        .status(health.status === "ok" ? StatusCodes.OK : StatusCodes.SERVICE_UNAVAILABLE)
        .json({ success: health.status === "ok", data: health });
    } catch (err) {
      next(err);
    }
  }
}

export const workerController = new WorkerController();
