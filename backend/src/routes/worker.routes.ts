/**
 * Verification worker routes, mounted under /api/v1/worker.
 *
 *   GET /api/v1/worker/health
 *     Worker liveness from heartbeats: overall status, number of live
 *     workers, and per-worker last heartbeat, last processed ledger,
 *     processed/failed counts and last request duration.
 *     200 while at least one worker is alive, 503 otherwise.
 */
import { Router } from "express";
import { workerController } from "../controllers/worker.controller";

const router = Router();

router.get("/health", workerController.getHealth.bind(workerController));

export default router;
