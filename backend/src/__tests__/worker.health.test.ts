/**
 * Worker heartbeats and GET /api/v1/worker/health (issue #695), against a
 * real MongoDB (mongodb-memory-server).
 */
jest.mock("../config/env", () => ({
  env: { NODE_ENV: "test", WORKER_HEARTBEAT_STALE_MS: 60_000 },
}));

import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";

import workerRoutes from "../routes/worker.routes";
import { globalErrorHandler } from "../middlewares/errorHandler";
import { workerHeartbeatService } from "../services/workerHeartbeat.service";
import { WorkerHeartbeatModel } from "../models/WorkerHeartbeat.model";

const STALE_MS = 60_000;

function buildApp(): express.Express {
  const app = express();
  app.use("/api/v1/worker", workerRoutes);
  app.use(globalErrorHandler);
  return app;
}

let mongo: MongoMemoryServer;
const app = buildApp();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await WorkerHeartbeatModel.syncIndexes();
});

afterEach(async () => {
  await WorkerHeartbeatModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("WorkerHeartbeatService.beat", () => {
  it("creates one document per worker and updates it in place", async () => {
    const startedAt = new Date(Date.now() - 5_000);

    await workerHeartbeatService.beat({ workerId: "w1", status: "running", startedAt, processedCount: 0, failedCount: 0 });
    await workerHeartbeatService.beat({
      workerId: "w1",
      status: "running",
      startedAt,
      processedCount: 7,
      failedCount: 2,
      lastProcessedLedger: 1_284_903,
      lastProcessingMs: 812.5,
    });

    const stored = await WorkerHeartbeatModel.find({ workerId: "w1" }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "running",
      startedAt,
      processedCount: 7,
      failedCount: 2,
      lastProcessedLedger: 1_284_903,
      lastProcessingMs: 812.5,
    });
  });

  it("keeps the last processed ledger when a later heartbeat has none", async () => {
    const startedAt = new Date();
    const base = { workerId: "w1", status: "running" as const, startedAt, processedCount: 1, failedCount: 0 };

    await workerHeartbeatService.beat({ ...base, lastProcessedLedger: 500 });
    await workerHeartbeatService.beat(base);

    const stored = await WorkerHeartbeatModel.findOne({ workerId: "w1" }).lean();
    expect(stored?.lastProcessedLedger).toBe(500);
  });
});

describe("WorkerHeartbeatService.getHealth", () => {
  it("counts running workers with a fresh heartbeat as alive", async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 600_000);
    const beat = (workerId: string, status: "running" | "stopped", ageMs: number) =>
      workerHeartbeatService.beat({
        workerId,
        status,
        startedAt,
        processedCount: 1,
        failedCount: 0,
        now: new Date(now.getTime() - ageMs),
      });
    await beat("fresh", "running", 1_000);
    await beat("stale", "running", STALE_MS + 1_000);
    await beat("stopped", "stopped", 1_000);
    await beat("long-gone", "running", STALE_MS * 20);

    const health = await workerHeartbeatService.getHealth(STALE_MS, now);

    expect(health).toMatchObject({ status: "ok", aliveWorkers: 1, staleAfterMs: STALE_MS });
    expect(Object.fromEntries(health.workers.map((w) => [w.workerId, w.alive]))).toEqual({
      fresh: true,
      stale: false,
      stopped: false,
    });
  });

  it("is unavailable when no worker is alive", async () => {
    const health = await workerHeartbeatService.getHealth(STALE_MS);
    expect(health).toMatchObject({ status: "unavailable", aliveWorkers: 0, workers: [] });
  });
});

describe("GET /api/v1/worker/health", () => {
  it("returns 200 with per-worker telemetry while a worker is alive", async () => {
    const startedAt = new Date(Date.now() - 60_000);
    await workerHeartbeatService.beat({
      workerId: "host:123:abcd",
      status: "running",
      startedAt,
      processedCount: 12,
      failedCount: 1,
      lastProcessedLedger: 777,
      lastProcessingMs: 1_530,
    });

    const res = await request(app).get("/api/v1/worker/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ status: "ok", aliveWorkers: 1, staleAfterMs: STALE_MS });
    expect(res.body.data.workers).toEqual([
      {
        workerId: "host:123:abcd",
        status: "running",
        alive: true,
        startedAt: startedAt.toISOString(),
        lastHeartbeatAt: expect.any(String),
        lastProcessedLedger: 777,
        processedCount: 12,
        failedCount: 1,
        lastProcessingMs: 1_530,
      },
    ]);
  });

  it("returns 503 when no worker has a fresh heartbeat", async () => {
    await workerHeartbeatService.beat({
      workerId: "w1",
      status: "running",
      startedAt: new Date(Date.now() - 600_000),
      processedCount: 0,
      failedCount: 0,
      now: new Date(Date.now() - STALE_MS * 2),
    });

    const res = await request(app).get("/api/v1/worker/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, data: { status: "unavailable", aliveWorkers: 0 } });
  });
});
