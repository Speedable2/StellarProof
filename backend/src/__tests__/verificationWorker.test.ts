import crypto from "crypto";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";

jest.mock("../config/env", () => ({
  env: {
    STELLAR_RPC_URL: "https://rpc.invalid",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    STELLAR_TX_POLL_INTERVAL_MS: 1_000,
    STELLAR_TX_CONFIRMATION_TIMEOUT_MS: 60_000,
    STELLAR_TX_MAX_CONSECUTIVE_RPC_ERRORS: 3,
    PINATA_GATEWAY_URL: "https://gateway.invalid/ipfs",
    SPV_FETCH_TIMEOUT_MS: 30_000,
    SPV_MAX_MEDIA_BYTES: 1_000_000,
    SPV_MAX_MANIFEST_BYTES: 100_000,
  },
}));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  VerificationWorker,
  installShutdownHandlers,
  isRetryableError,
  retryDelayMs,
  type VerificationWorkerDeps,
} from "../jobs/verificationWorker";
import { loadVerificationWorkerConfig, loadOracleConfig } from "../config/oracle";
import { AppError } from "../errors/AppError";
import { VerificationStateError } from "../errors/VerificationStateError";
import {
  SorobanRpcError,
  TransactionConfirmationTimeoutError,
  TransactionFailedError,
  TransactionSimulationError,
} from "../errors/SorobanTransactionError";
import { SpvFetchError } from "../services/spvVerifier.service";
import { LeaseLostError } from "../services/verificationRequestEvent.service";
import { attestationService } from "../services/attestation.service";
import {
  VALID_TRANSITIONS,
  VerificationStatus,
  type CreateVerificationJobDTO,
  type IVerificationJob,
  type UpdateVerificationStatusDTO,
} from "../types/verification.types";
import {
  VerificationRequestEventStatus,
  type IVerificationRequestEvent,
} from "../types/verificationRequestEvent.types";
import type { SuccessfulTransactionStatus } from "../types/soroban.types";

const hex32 = (): string => crypto.randomBytes(32).toString("hex");
const MEDIA_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const MANIFEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CONFIG = {
  pollIntervalMs: 5_000,
  batchSize: 10,
  maxAttempts: 3,
  retryBaseMs: 1_000,
  leaseMs: 300_000,
  concurrency: 1,
  heartbeatIntervalMs: 15_000,
};
const NOW = new Date("2026-01-01T00:00:00Z");

/**
 * In-memory job store that enforces the real VerificationJob transition
 * table, so tests fail if the worker attempts an illegal transition.
 */
class JobStore {
  readonly jobs = new Map<string, IVerificationJob>();
  readonly history: VerificationStatus[] = [];

  createJob = jest.fn(async (dto: CreateVerificationJobDTO): Promise<IVerificationJob> => {
    const job: IVerificationJob = {
      _id: crypto.randomBytes(12).toString("hex"),
      ownerPublicKey: dto.ownerPublicKey,
      contentHash: dto.contentHash,
      status: VerificationStatus.PENDING,
      timeline: [],
    };
    this.jobs.set(job._id as string, job);
    this.history.push(job.status);
    return { ...job };
  });

  getJob = jest.fn(async (id: string): Promise<IVerificationJob> => {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(`Verification job not found: '${id}'`, 404, "JOB_NOT_FOUND");
    return { ...job };
  });

  updateJobStatus = jest.fn(async (id: string, dto: UpdateVerificationStatusDTO): Promise<IVerificationJob> => {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(`Verification job not found: '${id}'`, 404, "JOB_NOT_FOUND");
    if (!VALID_TRANSITIONS[job.status].has(dto.status)) {
      throw new VerificationStateError(job.status, dto.status);
    }
    const { status, ...fields } = dto;
    Object.assign(job, fields, { status });
    this.history.push(status);
    return { ...job };
  });

  seed(partial: Partial<IVerificationJob> & { status: VerificationStatus }): IVerificationJob {
    const job: IVerificationJob = {
      _id: crypto.randomBytes(12).toString("hex"),
      ownerPublicKey: Keypair.random().publicKey(),
      contentHash: hex32(),
      timeline: [],
      ...partial,
    };
    this.jobs.set(job._id as string, job);
    return job;
  }
}

function makeEvent(overrides: Partial<IVerificationRequestEvent> = {}): IVerificationRequestEvent {
  return {
    _id: crypto.randomBytes(12).toString("hex"),
    eventId: `evt-${crypto.randomBytes(4).toString("hex")}`,
    mediaCid: MEDIA_CID,
    manifestCid: MANIFEST_CID,
    requester: Keypair.random().publicKey(),
    status: VerificationRequestEventStatus.PROCESSING,
    attempts: 1,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

function confirmed(txHash: string, certificateId?: number): SuccessfulTransactionStatus {
  return {
    status: "SUCCESS",
    txHash,
    ledger: 777,
    createdAt: 1_700_000_000,
    ...(certificateId !== undefined
      ? { returnValue: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(certificateId))) }
      : {}),
  };
}

function harness(pending: IVerificationRequestEvent[] = []) {
  const oracle = {
    keypair: Keypair.random(),
    provenanceContractId: StrKey.encodeContract(crypto.randomBytes(32)),
    codeMeasurementHash: hex32(),
  };
  const jobs = new JobStore();
  const contentHash = hex32();
  const manifestHash = hex32();
  const mintHash = hex32();
  const calls: string[] = [];

  const queue = {
    claim: jest.fn(async () => pending.shift() ?? null),
    release: jest.fn(async () => undefined),
    deadLetter: jest.fn(async () => undefined),
  };
  const events = {
    attachJob: jest.fn(async () => undefined),
    recordVerification: jest.fn(async () => undefined),
    recordTransaction: jest.fn(async () => {
      calls.push("recordTransaction");
    }),
    markCompleted: jest.fn(async () => {
      calls.push("markCompleted");
    }),
    markFailed: jest.fn(async () => undefined),
  };
  const verifier = {
    verify: jest.fn(async () => ({ verified: true, contentHash, manifestHash })),
  };
  const soroban = {
    buildMintTransaction: jest.fn(async () => {
      calls.push("build");
      return { hash: mintHash, xdr: "AAAA", transaction: {} as never };
    }),
    submitTransaction: jest.fn(async () => {
      calls.push("submit");
    }),
    getTransactionWithConfirmation: jest.fn(async (txHash: string) => {
      calls.push("confirm");
      return confirmed(txHash, 42);
    }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const deps: VerificationWorkerDeps = {
    queue,
    events,
    jobs,
    verifier,
    attestations: attestationService,
    soroban,
    oracle,
    config: { ...CONFIG },
    logger,
    workerId: "worker-test",
    now: () => NOW,
  };

  return {
    deps,
    worker: new VerificationWorker(deps),
    jobs,
    queue,
    events,
    verifier,
    soroban,
    logger,
    oracle,
    calls,
    contentHash,
    manifestHash,
    mintHash,
  };
}

describe("VerificationWorker — happy path", () => {
  it("discovers every due event in a cycle and stops when the queue is empty", async () => {
    const h = harness([makeEvent(), makeEvent()]);

    await expect(h.worker.runCycle()).resolves.toBe(2);

    expect(h.queue.claim).toHaveBeenCalledTimes(3);
    expect(h.queue.claim).toHaveBeenCalledWith({
      workerId: "worker-test",
      leaseMs: CONFIG.leaseMs,
      now: NOW,
    });
    expect(h.events.markCompleted).toHaveBeenCalledTimes(2);
  });

  it("caps each cycle at the configured batch size", async () => {
    const h = harness([makeEvent(), makeEvent(), makeEvent()]);
    h.deps.config.batchSize = 2;

    await expect(new VerificationWorker(h.deps).runCycle()).resolves.toBe(2);
  });

  it("maps the event to a VerificationJob and runs SPV verification on its CIDs", async () => {
    const event = makeEvent();
    const h = harness([event]);

    await h.worker.runCycle();

    expect(h.verifier.verify).toHaveBeenCalledWith({
      mediaCid: MEDIA_CID,
      manifestCid: MANIFEST_CID,
      requester: event.requester,
    });
    expect(h.jobs.createJob).toHaveBeenCalledWith({
      ownerPublicKey: event.requester,
      contentHash: h.contentHash,
      manifestHash: h.manifestHash,
      requestId: event.eventId,
    });
    const [jobId] = [...h.jobs.jobs.keys()];
    expect(h.events.attachJob).toHaveBeenCalledWith(event._id, "worker-test", jobId);
    expect(h.events.recordVerification).toHaveBeenCalledWith(event._id, "worker-test", {
      contentHash: h.contentHash,
      manifestHash: h.manifestHash,
    });
  });

  it("submits a signed attestation mint and records the tx hash before sending", async () => {
    const event = makeEvent();
    const h = harness([event]);

    await h.worker.runCycle();

    const job = [...h.jobs.jobs.values()][0];
    expect(job.teeAttestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.codeMeasurementHash).toBe(h.oracle.codeMeasurementHash);
    expect(
      h.oracle.keypair.verify(
        Buffer.from(job.teeAttestationHash as string, "hex"),
        Buffer.from(job.teeSignature as string, "hex")
      )
    ).toBe(true);

    expect(h.soroban.buildMintTransaction).toHaveBeenCalledWith(
      h.oracle.keypair,
      h.oracle.provenanceContractId,
      {
        to: event.requester,
        mediaCid: MEDIA_CID,
        manifestHash: h.manifestHash,
        attestationHash: job.teeAttestationHash,
      }
    );
    expect(h.events.recordTransaction).toHaveBeenCalledWith(event._id, "worker-test", h.mintHash);
    expect(h.calls.indexOf("recordTransaction")).toBeLessThan(h.calls.indexOf("submit"));
  });

  it("completes the job only after the transaction is confirmed", async () => {
    const event = makeEvent();
    const h = harness([event]);
    let release: (value: SuccessfulTransactionStatus) => void = () => undefined;
    h.soroban.getTransactionWithConfirmation.mockImplementation(
      () => new Promise<SuccessfulTransactionStatus>((resolve) => (release = resolve))
    );

    const cycle = h.worker.runCycle();
    await new Promise((resolve) => setImmediate(resolve));

    const job = [...h.jobs.jobs.values()][0];
    expect(job.status).toBe(VerificationStatus.MINTING);
    expect(job.stellarTransactionHash).toBe(h.mintHash);
    expect(h.events.markCompleted).not.toHaveBeenCalled();

    release(confirmed(h.mintHash, 9));
    await cycle;

    expect(job.status).toBe(VerificationStatus.COMPLETED);
    expect(h.jobs.history).toEqual([
      VerificationStatus.PENDING,
      VerificationStatus.PROCESSING,
      VerificationStatus.TEE_VERIFYING,
      VerificationStatus.MINTING,
      VerificationStatus.COMPLETED,
    ]);
    expect(h.events.markCompleted).toHaveBeenCalledWith(event._id, "worker-test", {
      transactionHash: h.mintHash,
      certificateId: "9",
    });
  });
});

describe("VerificationWorker — failures", () => {
  it("fails the job and event when SPV verification rejects, without minting", async () => {
    const event = makeEvent();
    const h = harness([event]);
    h.verifier.verify.mockResolvedValue({
      verified: false,
      contentHash: h.contentHash,
      manifestHash: h.manifestHash,
      reason: "Media SHA-256 does not match the manifest contentHash",
    } as never);

    await h.worker.runCycle();

    const job = [...h.jobs.jobs.values()][0];
    expect(job.status).toBe(VerificationStatus.FAILED);
    expect(job.errorMessage).toContain("does not match");
    expect(h.events.markFailed).toHaveBeenCalledWith(
      event._id,
      "worker-test",
      expect.stringContaining("SPV verification failed")
    );
    expect(h.soroban.buildMintTransaction).not.toHaveBeenCalled();
    expect(h.queue.release).not.toHaveBeenCalled();
  });

  it("fails the job and event when the mint transaction fails on-chain", async () => {
    const event = makeEvent();
    const h = harness([event]);
    h.soroban.getTransactionWithConfirmation.mockRejectedValue(
      new TransactionFailedError({
        txHash: h.mintHash,
        resultCode: "tx_failed",
        operationResultCodes: ["invoke_host_function_trapped"],
        diagnosticEventsXdr: [],
        ledger: 10,
      })
    );

    await h.worker.runCycle();

    const job = [...h.jobs.jobs.values()][0];
    expect(job.status).toBe(VerificationStatus.FAILED);
    expect(job.errorMessage).toContain("tx_failed");
    expect(h.queue.deadLetter).toHaveBeenCalledWith(
      event,
      "worker-test",
      expect.objectContaining({ reason: expect.stringContaining("tx_failed"), retryable: false, jobId: job._id }),
      NOW
    );
    expect(h.events.markCompleted).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      "Verification worker: event dead-lettered",
      expect.objectContaining({ diagnostics: expect.objectContaining({ resultCode: "tx_failed" }) })
    );
  });

  it("fails without retry when simulation rejects the mint", async () => {
    const h = harness([makeEvent()]);
    h.soroban.buildMintTransaction.mockRejectedValue(
      new TransactionSimulationError("Simulation of mint failed: already exists")
    );

    await h.worker.runCycle();

    expect(h.queue.release).not.toHaveBeenCalled();
    expect([...h.jobs.jobs.values()][0].status).toBe(VerificationStatus.FAILED);
  });

  it("clears the recorded hash when the RPC rejects the submission", async () => {
    const event = makeEvent();
    const h = harness([event]);
    h.soroban.submitTransaction.mockRejectedValue(
      new TransactionFailedError({
        txHash: h.mintHash,
        resultCode: "tx_bad_seq",
        operationResultCodes: [],
        diagnosticEventsXdr: [],
      })
    );

    await h.worker.runCycle();

    expect(h.events.recordTransaction).toHaveBeenLastCalledWith(event._id, "worker-test", null);
    // tx_bad_seq is fixed by rebuilding, so the event is retried and the job stays resumable.
    expect(h.queue.release).toHaveBeenCalled();
    expect([...h.jobs.jobs.values()][0].status).toBe(VerificationStatus.TEE_VERIFYING);
  });

  it("isolates failures so one bad event does not stop the rest of the batch", async () => {
    const first = makeEvent();
    const second = makeEvent();
    const h = harness([first, second]);
    h.verifier.verify.mockRejectedValueOnce(new Error("unexpected crash"));

    await expect(h.worker.runCycle()).resolves.toBe(2);

    expect(h.queue.release).toHaveBeenCalledWith(first._id, "worker-test", expect.any(Date), "unexpected crash");
    expect(h.events.markCompleted).toHaveBeenCalledWith(second._id, "worker-test", expect.anything());
  });

  it("survives a claim failure and ends the cycle cleanly", async () => {
    const h = harness();
    h.queue.claim.mockRejectedValueOnce(new Error("MongoNetworkError"));

    await expect(h.worker.runCycle()).resolves.toBe(0);
    expect(h.logger.error).toHaveBeenCalledWith(
      "Verification worker: failed to claim event",
      expect.objectContaining({ error: "MongoNetworkError" })
    );
  });
});

describe("VerificationWorker — retry and recovery", () => {
  it("schedules a retry with exponential back-off for retryable errors", async () => {
    const event = makeEvent({ attempts: 2 });
    const h = harness([event]);
    h.verifier.verify.mockRejectedValue(new SpvFetchError("Gateway returned HTTP 503", true));

    await h.worker.runCycle();

    expect(h.queue.release).toHaveBeenCalledWith(
      event._id,
      "worker-test",
      new Date(NOW.getTime() + CONFIG.retryBaseMs * 2),
      "Gateway returned HTTP 503"
    );
    expect(h.events.markFailed).not.toHaveBeenCalled();
    expect(h.queue.deadLetter).not.toHaveBeenCalled();
  });

  it("marks the event failed once retryable errors exhaust max attempts", async () => {
    const event = makeEvent({ attempts: CONFIG.maxAttempts });
    const h = harness([event]);
    h.verifier.verify.mockRejectedValue(new SpvFetchError("Gateway returned HTTP 503", true));

    await h.worker.runCycle();

    expect(h.queue.release).not.toHaveBeenCalled();
    expect(h.queue.deadLetter).toHaveBeenCalledWith(
      event,
      "worker-test",
      expect.objectContaining({ reason: "Gateway returned HTTP 503", retryable: true }),
      NOW
    );
  });

  it("fails an event reclaimed beyond max attempts without reprocessing it", async () => {
    const h = harness([makeEvent({ attempts: CONFIG.maxAttempts + 1 })]);

    await h.worker.runCycle();

    expect(h.verifier.verify).not.toHaveBeenCalled();
    expect(h.queue.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: CONFIG.maxAttempts + 1 }),
      "worker-test",
      expect.objectContaining({
        reason: expect.stringContaining("Exceeded"),
        errorCode: "MAX_ATTEMPTS_EXCEEDED",
        retryable: false,
      }),
      NOW
    );
  });

  it("resumes a job left in minting by confirming its recorded transaction", async () => {
    const h = harness();
    const txHash = hex32();
    const job = h.jobs.seed({ status: VerificationStatus.MINTING, stellarTransactionHash: txHash });
    const event = makeEvent({ verificationJobId: job._id, attempts: 2 });

    await h.worker.processEvent(event);

    expect(h.verifier.verify).not.toHaveBeenCalled();
    expect(h.soroban.buildMintTransaction).not.toHaveBeenCalled();
    expect(h.soroban.getTransactionWithConfirmation).toHaveBeenCalledWith(txHash);
    expect(h.jobs.jobs.get(job._id as string)?.status).toBe(VerificationStatus.COMPLETED);
  });

  it("recovers a submitted-but-unrecorded mint without minting twice", async () => {
    const h = harness();
    const txHash = hex32();
    const job = h.jobs.seed({
      status: VerificationStatus.TEE_VERIFYING,
      teeAttestationHash: hex32(),
      codeMeasurementHash: hex32(),
    });
    const event = makeEvent({
      verificationJobId: job._id,
      transactionHash: txHash,
      manifestHash: hex32(),
      attempts: 2,
    });

    await h.worker.processEvent(event);

    expect(h.soroban.buildMintTransaction).not.toHaveBeenCalled();
    expect(h.jobs.jobs.get(job._id as string)).toMatchObject({
      status: VerificationStatus.COMPLETED,
      stellarTransactionHash: txHash,
    });
  });

  it("rebuilds the mint when a previously submitted transaction expired", async () => {
    const h = harness();
    const staleHash = hex32();
    const job = h.jobs.seed({
      status: VerificationStatus.TEE_VERIFYING,
      teeAttestationHash: hex32(),
      codeMeasurementHash: hex32(),
    });
    const event = makeEvent({
      verificationJobId: job._id,
      transactionHash: staleHash,
      manifestHash: hex32(),
      attempts: 2,
    });
    h.soroban.getTransactionWithConfirmation
      .mockRejectedValueOnce(new TransactionConfirmationTimeoutError(staleHash, 60_000, 30, false))
      .mockImplementation(async (hash: string) => confirmed(hash));

    await h.worker.processEvent(event);

    expect(h.events.recordTransaction).toHaveBeenCalledWith(event._id, "worker-test", null);
    expect(h.soroban.buildMintTransaction).toHaveBeenCalledTimes(1);
    expect(h.jobs.jobs.get(job._id as string)).toMatchObject({
      status: VerificationStatus.COMPLETED,
      stellarTransactionHash: h.mintHash,
    });
  });

  it("retries instead of failing when finality is unknown because of RPC errors", async () => {
    const event = makeEvent();
    const h = harness([event]);
    h.soroban.getTransactionWithConfirmation.mockRejectedValue(
      new SorobanRpcError("getTransaction failed: ECONNRESET")
    );

    await h.worker.runCycle();

    expect(h.queue.release).toHaveBeenCalled();
    // The job keeps its tx hash in minting so the next attempt resumes confirmation.
    expect([...h.jobs.jobs.values()][0]).toMatchObject({
      status: VerificationStatus.MINTING,
      stellarTransactionHash: h.mintHash,
    });
  });
});

describe("VerificationWorker — duplicate protection", () => {
  it("rejects an overlapping cycle", async () => {
    const h = harness([makeEvent()]);
    let release: () => void = () => undefined;
    h.verifier.verify.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ verified: true, contentHash: h.contentHash, manifestHash: h.manifestHash });
        })
    );

    const first = h.worker.runCycle();
    await expect(h.worker.runCycle()).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(1);
    expect(h.verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("does not re-mint an event whose job already completed", async () => {
    const h = harness();
    const txHash = hex32();
    const job = h.jobs.seed({ status: VerificationStatus.COMPLETED, stellarTransactionHash: txHash });

    await h.worker.processEvent(makeEvent({ verificationJobId: job._id }));

    expect(h.verifier.verify).not.toHaveBeenCalled();
    expect(h.soroban.buildMintTransaction).not.toHaveBeenCalled();
    expect(h.events.markCompleted).toHaveBeenCalledWith(expect.any(String), "worker-test", {
      transactionHash: txHash,
    });
  });

  it("abandons an event whose lease was taken over, without further writes", async () => {
    const event = makeEvent();
    const h = harness([event]);
    h.events.attachJob.mockRejectedValue(new LeaseLostError(event._id));

    await h.worker.runCycle();

    expect(h.soroban.buildMintTransaction).not.toHaveBeenCalled();
    expect(h.events.markFailed).not.toHaveBeenCalled();
    expect(h.queue.deadLetter).not.toHaveBeenCalled();
    expect(h.queue.release).not.toHaveBeenCalled();
  });
});

describe("VerificationWorker — lifecycle", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("polls on the configured interval, never overlapping cycles", async () => {
    jest.useFakeTimers();
    const h = harness();
    h.deps.config.pollIntervalMs = 7_000;
    const worker = new VerificationWorker(h.deps);

    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.queue.claim).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(6_999);
    expect(h.queue.claim).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(h.queue.claim).toHaveBeenCalledTimes(2);

    await worker.stop();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(h.queue.claim).toHaveBeenCalledTimes(2);
  });

  it("stop() waits for the in-flight event and claims nothing more", async () => {
    const h = harness([makeEvent(), makeEvent()]);
    let release: () => void = () => undefined;
    h.verifier.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ verified: true, contentHash: h.contentHash, manifestHash: h.manifestHash });
        })
    );

    h.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = h.worker.stop();
    let stopResolved = false;
    void stopped.then(() => (stopResolved = true));

    await new Promise((resolve) => setImmediate(resolve));
    expect(stopResolved).toBe(false);

    release();
    await stopped;

    expect(h.events.markCompleted).toHaveBeenCalledTimes(1);
    expect(h.queue.claim).toHaveBeenCalledTimes(1);
    expect(h.worker.isRunning).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("shuts down gracefully on %s", async (signal) => {
    const h = harness();
    const onStopped = jest.fn(async () => undefined);
    const exit = jest.fn();
    h.worker.start();
    const uninstall = installShutdownHandlers(h.worker, { onStopped, exit });

    try {
      process.emit(signal, signal);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(h.worker.isRunning).toBe(false);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      uninstall();
    }
  });
});

describe("VerificationWorker — job state persistence (#696)", () => {
  it("stores the minted certificate id on the completed job", async () => {
    const h = harness([makeEvent()]);

    await h.worker.runCycle();

    const job = [...h.jobs.jobs.values()][0];
    expect(job).toMatchObject({
      status: VerificationStatus.COMPLETED,
      certificateId: "42",
      stellarTransactionHash: h.mintHash,
      codeMeasurementHash: h.oracle.codeMeasurementHash,
    });
    expect(job.teeAttestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.teeSignature).toEqual(expect.any(String));
  });
});

describe("VerificationWorker — concurrency (#694)", () => {
  it("processes a batch across parallel lanes without exceeding the configured concurrency", async () => {
    const events = Array.from({ length: 6 }, () => makeEvent());
    const h = harness([...events]);
    h.deps.config.concurrency = 3;
    let inFlight = 0;
    let peak = 0;
    h.verifier.verify.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { verified: true, contentHash: hex32(), manifestHash: hex32() };
    });

    await expect(new VerificationWorker(h.deps).runCycle()).resolves.toBe(6);

    expect(peak).toBe(3);
    expect(h.events.markCompleted).toHaveBeenCalledTimes(6);
    const completed = h.events.markCompleted.mock.calls.map((call: unknown[]) => call[0]);
    expect(new Set(completed)).toEqual(new Set(events.map((event) => event._id)));
  });

  it("never claims more than the batch size, whatever the concurrency", async () => {
    const h = harness(Array.from({ length: 10 }, () => makeEvent()));
    h.deps.config.concurrency = 8;
    h.deps.config.batchSize = 3;

    await expect(new VerificationWorker(h.deps).runCycle()).resolves.toBe(3);
    expect(h.queue.claim).toHaveBeenCalledTimes(3);
  });

  it("stops every lane once the queue is empty", async () => {
    const h = harness([makeEvent()]);
    h.deps.config.concurrency = 4;

    await expect(new VerificationWorker(h.deps).runCycle()).resolves.toBe(1);
    expect(h.queue.claim.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("VerificationWorker — retry policy and dead letters (#693)", () => {
  it("doubles the back-off per attempt and caps it at 15 minutes", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, 1_000))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(30, 1_000)).toBe(15 * 60 * 1_000);
    expect(retryDelayMs(3, 1_000, 3_000)).toBe(3_000);
  });

  it("does not dead-letter a request whose content failed SPV verification", async () => {
    const h = harness([makeEvent()]);
    h.verifier.verify.mockResolvedValue({
      verified: false,
      contentHash: h.contentHash,
      manifestHash: h.manifestHash,
      reason: "Manifest creator does not match the verification requester",
    } as never);

    await h.worker.runCycle();

    expect(h.queue.deadLetter).not.toHaveBeenCalled();
    expect(h.events.markFailed).toHaveBeenCalled();
  });

  it("fails the linked job with the reason before dead-lettering", async () => {
    const h = harness([makeEvent()]);
    h.soroban.buildMintTransaction.mockRejectedValue(
      new TransactionSimulationError("Simulation of mint failed: already exists")
    );
    h.queue.deadLetter.mockImplementation(async () => {
      expect([...h.jobs.jobs.values()][0]).toMatchObject({
        status: VerificationStatus.FAILED,
        errorMessage: "Simulation of mint failed: already exists",
      });
    });

    await h.worker.runCycle();

    expect(h.queue.deadLetter).toHaveBeenCalledTimes(1);
  });
});

describe("VerificationWorker — heartbeat and telemetry (#695)", () => {
  function withHeartbeat(pending: IVerificationRequestEvent[] = []) {
    const h = harness(pending);
    const heartbeat = { beat: jest.fn(async () => undefined) };
    h.deps.heartbeat = heartbeat;
    return { ...h, heartbeat, worker: new VerificationWorker(h.deps) };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it("logs how long each request took", async () => {
    const h = harness([makeEvent()]);

    await h.worker.runCycle();

    expect(h.logger.info).toHaveBeenCalledWith(
      "Verification worker: event finished",
      expect.objectContaining({ outcome: "completed", durationMs: expect.any(Number) })
    );
  });

  it("logs the duration of attempts that end in a retry", async () => {
    const h = harness([makeEvent()]);
    h.verifier.verify.mockRejectedValue(new SpvFetchError("Gateway returned HTTP 503", true));

    await h.worker.runCycle();

    expect(h.logger.info).toHaveBeenCalledWith(
      "Verification worker: event attempt ended",
      expect.objectContaining({ outcome: "retry-scheduled", durationMs: expect.any(Number) })
    );
  });

  it("reports running on start, counters after each cycle, and stopped on stop", async () => {
    jest.useFakeTimers();
    const h = withHeartbeat([makeEvent(), makeEvent()]);
    h.verifier.verify.mockResolvedValueOnce({
      verified: false,
      contentHash: h.contentHash,
      manifestHash: h.manifestHash,
      reason: "rejected",
    } as never);

    h.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    await h.worker.stop();

    const beats = h.heartbeat.beat.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>);
    expect(beats[0]).toMatchObject({ workerId: "worker-test", status: "running", processedCount: 0 });
    expect(beats).toContainEqual(
      expect.objectContaining({
        status: "running",
        processedCount: 2,
        failedCount: 1,
        lastProcessedLedger: 777,
        lastProcessingMs: expect.any(Number),
      })
    );
    expect(beats.at(-1)).toMatchObject({ status: "stopped", processedCount: 2 });
  });

  it("beats on the configured interval while idle", async () => {
    jest.useFakeTimers();
    const h = withHeartbeat();
    h.deps.config.heartbeatIntervalMs = 1_000;
    h.deps.config.pollIntervalMs = 60_000;
    const worker = new VerificationWorker(h.deps);

    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    const afterStart = h.heartbeat.beat.mock.calls.length;
    await jest.advanceTimersByTimeAsync(3_000);

    expect(h.heartbeat.beat.mock.calls.length - afterStart).toBe(3);
    await worker.stop();
  });

  it("keeps processing when a heartbeat cannot be written", async () => {
    jest.useFakeTimers();
    const h = withHeartbeat([makeEvent()]);
    h.heartbeat.beat.mockRejectedValue(new Error("MongoNetworkError"));

    h.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    await h.worker.stop();

    expect(h.events.markCompleted).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "Verification worker: heartbeat failed",
      expect.objectContaining({ error: "MongoNetworkError" })
    );
  });
});

describe("isRetryableError", () => {
  it("classifies transport, contract, and application errors", () => {
    expect(isRetryableError(new SorobanRpcError("down"))).toBe(true);
    expect(isRetryableError(new SpvFetchError("404", true))).toBe(true);
    expect(isRetryableError(new SpvFetchError("too large", false))).toBe(false);
    expect(isRetryableError(new TransactionSimulationError("panic"))).toBe(false);
    expect(isRetryableError(new VerificationStateError("completed", "failed"))).toBe(false);
    expect(isRetryableError(new Error("socket closed"))).toBe(true);
  });
});

describe("worker configuration", () => {
  const base = {
    VERIFICATION_WORKER_POLL_INTERVAL_MS: 5_000,
    VERIFICATION_WORKER_BATCH_SIZE: 10,
    VERIFICATION_WORKER_MAX_ATTEMPTS: 3,
    VERIFICATION_WORKER_RETRY_BASE_MS: 30_000,
    VERIFICATION_WORKER_LEASE_MS: 300_000,
    VERIFICATION_WORKER_CONCURRENCY: 4,
    VERIFICATION_WORKER_HEARTBEAT_INTERVAL_MS: 15_000,
    STELLAR_TX_CONFIRMATION_TIMEOUT_MS: 60_000,
    SPV_FETCH_TIMEOUT_MS: 30_000,
  };

  it("reads the polling interval and limits from configuration", () => {
    expect(
      loadVerificationWorkerConfig({ ...base, VERIFICATION_WORKER_POLL_INTERVAL_MS: 1_234 })
    ).toEqual({
      pollIntervalMs: 1_234,
      batchSize: 10,
      maxAttempts: 3,
      retryBaseMs: 30_000,
      leaseMs: 300_000,
      concurrency: 4,
      heartbeatIntervalMs: 15_000,
    });
  });

  it("rejects a confirmation timeout within the transaction validity window", () => {
    expect(() =>
      loadVerificationWorkerConfig({ ...base, STELLAR_TX_CONFIRMATION_TIMEOUT_MS: 30_000 })
    ).toThrow(/STELLAR_TX_CONFIRMATION_TIMEOUT_MS/);
  });

  it("rejects a lease too short to cover a processing pass", () => {
    expect(() =>
      loadVerificationWorkerConfig({ ...base, VERIFICATION_WORKER_LEASE_MS: 180_000 })
    ).toThrow(/VERIFICATION_WORKER_LEASE_MS/);
  });

  it("validates oracle credentials without echoing the secret", () => {
    const secret = Keypair.random().secret();
    const good = {
      STELLAR_ORACLE_SECRET_KEY: secret,
      STELLAR_PROVENANCE_CONTRACT_ID: StrKey.encodeContract(crypto.randomBytes(32)),
      ORACLE_CODE_MEASUREMENT_HASH: hex32().toUpperCase(),
    };

    const config = loadOracleConfig(good);
    expect(config.keypair.secret()).toBe(secret);
    expect(config.codeMeasurementHash).toBe(good.ORACLE_CODE_MEASUREMENT_HASH.toLowerCase());

    const badSecret = `${secret.slice(0, -1)}A`;
    try {
      loadOracleConfig({ ...good, STELLAR_ORACLE_SECRET_KEY: badSecret });
      fail("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(badSecret);
      expect((err as AppError).code).toBe("ORACLE_CONFIG_INVALID");
    }
    expect(() => loadOracleConfig({ ...good, STELLAR_PROVENANCE_CONTRACT_ID: "" })).toThrow(
      /STELLAR_PROVENANCE_CONTRACT_ID/
    );
    expect(() => loadOracleConfig({ ...good, ORACLE_CODE_MEASUREMENT_HASH: "abc" })).toThrow(
      /ORACLE_CODE_MEASUREMENT_HASH/
    );
  });
});
