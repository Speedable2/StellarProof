/**
 * Verification worker: a long-running process that drives each
 * VerificationRequestEvent through the off-chain pipeline.
 *
 *   claim event → SPV verify → create/advance VerificationJob
 *     → attest → build + sign provenance.mint → submit
 *     → wait for SUCCESS → complete job
 *
 * Guarantees:
 * - One cycle at a time per worker (the next cycle is scheduled only after
 *   the current one finishes). Within a cycle, `concurrency` lanes process
 *   different events in parallel.
 * - One worker per event, across any number of worker processes: events are
 *   claimed through the `WorkerQueue` (atomic claim + lease).
 * - Every job moves through the VerificationJob state machine
 *   (pending → processing → tee_verifying → minting → completed), and the
 *   attestation hash, signature, code measurement and mint transaction hash
 *   are persisted at the stage that produces them.
 * - A job is marked completed only after the mint transaction is confirmed
 *   `SUCCESS` on-chain.
 * - Each event is processed in isolation: its failure is recorded and the
 *   worker moves on.
 * - Processing resumes from the job's current state, so a crash at any step
 *   is recovered when the event's lease expires and it is reclaimed.
 * - Transient failures are retried with exponential back-off. A request that
 *   cannot succeed, or runs out of attempts, is dead-lettered and its job is
 *   marked failed with the reason.
 * - Each worker records a heartbeat (see `GET /api/v1/worker/health`) and
 *   logs how long every request took.
 *
 * `verifyManifestForJob` / `startManifestRehashWorker` run the separate
 * manifest re-hash integrity check on pending jobs.
 *
 * Run standalone: `pnpm worker:verification` (dev) or `pnpm start:worker`.
 */
import os from "os";
import crypto from "crypto";
import cron from "node-cron";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { connectDatabase, disconnectDatabase } from "../config/database";
import {
  loadOracleConfig,
  loadVerificationWorkerConfig,
  type OracleConfig,
  type VerificationWorkerConfig,
} from "../config/oracle";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import {
  SorobanTransactionError,
  TransactionConfirmationTimeoutError,
  TransactionFailedError,
  TransactionSubmissionError,
} from "../errors/SorobanTransactionError";
import { attestationService, type Attestation, type AttestationInput } from "../services/attestation.service";
import { sorobanService, type SorobanService } from "../services/soroban.service";
import {
  SpvFetchError,
  spvVerifierService,
  type SpvVerificationRequest,
  type SpvVerificationResult,
} from "../services/spvVerifier.service";
import { verificationService } from "../services/verification.service";
import { RegistryAuthorizationService } from "../services/registryAuthorization.service";
import { SorobanContractQueryClient } from "../services/contracts/ContractReader";
import { RegistryContract } from "../services/contracts/RegistryContract";
import { OracleContract } from "../services/contracts/OracleContract";
import {
  LeaseLostError,
  verificationRequestEventService,
  type VerificationRequestEventServiceType,
} from "../services/verificationRequestEvent.service";
import { workerQueue, type WorkerQueue } from "../services/workerQueue.service";
import { workerHeartbeatService, type WorkerHeartbeatService } from "../services/workerHeartbeat.service";
import type { WorkerStatus } from "../models/WorkerHeartbeat.model";
import logger from "../utils/logger";
import { VerificationStatus, type IVerificationJob } from "../types/verification.types";
import type { IVerificationRequestEvent } from "../types/verificationRequestEvent.types";

/** Upper bound on retry back-off regardless of attempt count. */
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

type Logger = Pick<typeof logger, "info" | "warn" | "error" | "debug">;

export interface VerificationWorkerDeps {
  /** Source of work: claim, release for retry, dead-letter. */
  queue: WorkerQueue;
  /** Progress records on the claimed event. */
  events: Pick<
    VerificationRequestEventServiceType,
    "attachJob" | "recordVerification" | "recordTransaction" | "markCompleted" | "markFailed"
  >;
  jobs: Pick<typeof verificationService, "createJob" | "getJob" | "updateJobStatus">;
  verifier: { verify(request: SpvVerificationRequest): Promise<SpvVerificationResult> };
  attestations: {
    createAttestation(input: AttestationInput, keypair: Keypair, codeMeasurementHash: string): Attestation;
  };
  authorization?: Pick<RegistryAuthorizationService, "assertAuthorized">;
  soroban: Pick<
    SorobanService,
    "buildMintTransaction" | "submitTransaction" | "getTransactionWithConfirmation"
  >;
  oracle: OracleConfig;
  config: VerificationWorkerConfig;
  logger: Logger;
  /** Liveness reporting; heartbeats are skipped when omitted. */
  heartbeat?: Pick<WorkerHeartbeatService, "beat">;
  workerId?: string;
  now?: () => Date;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the manifest integrity check for a single job. Fetches the
 * manifest's stored JSON from IPFS, recomputes its deterministic hash, and
 * compares it to the manifest's recorded `manifestHash`. On mismatch, the
 * job is transitioned to `failed`.
 */
export async function verifyManifestForJob(
  jobId: string
): Promise<IVerificationJob> {
  return verificationService.verifyManifestIntegrity(jobId);
}

/**
 * Starts a scheduled scan of `pending` verification jobs that have an
 * associated manifest, running the manifest re-hash check on each.
 */
export function startManifestRehashWorker(): void {
  // Run every minute, alongside the existing timeout job.
  cron.schedule("* * * * *", async () => {
    try {
      // Scan for pending jobs that need manifest verification
      const pendingJobs = await verificationService.getPendingJobsWithManifest();
      
      for (const job of pendingJobs) {
        try {
          await verifyManifestForJob(String(job._id));
          logger.info("Manifest verification completed", { 
            jobId: String(job._id),
            manifestHash: job.manifestHash 
          });
        } catch (error) {
          logger.error("Manifest verification failed", {
            jobId: String(job._id),
            error: describeError(error)
          });
        }
      }
    } catch (error) {
      logger.error("Manifest rehash worker error:", error);
    }
  });
}

/**
 * Whether a later attempt could succeed. Unknown (non-application) errors,
 * such as a dropped database connection, are treated as transient.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof SorobanTransactionError) return err.retryable;
  if (err instanceof SpvFetchError) return err.retryable;
  if (err instanceof AppError) return false;
  return true;
}

/**
 * Back-off before retry number `attempt` (1-based): doubles from `baseMs`
 * and is capped at `maxMs`.
 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number = MAX_RETRY_DELAY_MS): number {
  return Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), maxMs);
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** True when a previously submitted transaction definitely did not take effect. */
function transactionDidNotLand(err: unknown): boolean {
  return (
    (err instanceof TransactionFailedError && err.diagnostics.ledger !== undefined) ||
    (err instanceof TransactionConfirmationTimeoutError && !err.outcomeUnknown)
  );
}

function isTerminal(status: VerificationStatus): boolean {
  return status === VerificationStatus.COMPLETED || status === VerificationStatus.FAILED;
}

export class VerificationWorker {
  private readonly workerId: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private currentCycle: Promise<number> | null = null;
  private running = false;
  private stopRequested = false;
  private startedAt: Date | null = null;
  private readonly stats = {
    processed: 0,
    failed: 0,
    lastProcessingMs: undefined as number | undefined,
    lastProcessedLedger: undefined as number | undefined,
  };

  constructor(private readonly deps: VerificationWorkerDeps) {
    this.workerId =
      deps.workerId ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
    this.now = deps.now ?? (() => new Date());
  }

  get id(): string {
    return this.workerId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts polling immediately, then every `pollIntervalMs` after each cycle ends. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.startedAt = this.now();
    this.deps.logger.info("Verification worker: started", {
      workerId: this.workerId,
      pollIntervalMs: this.deps.config.pollIntervalMs,
      batchSize: this.deps.config.batchSize,
      concurrency: this.deps.config.concurrency,
      oracle: this.deps.oracle.keypair.publicKey(),
    });
    void this.recordHeartbeat("running");
    if (this.deps.heartbeat) {
      this.heartbeatTimer = setInterval(() => {
        void this.recordHeartbeat("running");
      }, this.deps.config.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    }
    this.scheduleNext(0);
  }

  /** Stops scheduling new cycles and waits for the in-flight cycle to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.recordHeartbeat("stopping");
    if (this.currentCycle) {
      await this.currentCycle;
    }
    await this.recordHeartbeat("stopped");
    this.deps.logger.info("Verification worker: stopped", { workerId: this.workerId });
  }

  /** Persists this worker's liveness and counters. Failures are logged, never thrown. */
  private async recordHeartbeat(status: WorkerStatus): Promise<void> {
    if (!this.deps.heartbeat || !this.startedAt) return;
    try {
      await this.deps.heartbeat.beat({
        workerId: this.workerId,
        status,
        startedAt: this.startedAt,
        processedCount: this.stats.processed,
        failedCount: this.stats.failed,
        lastProcessedLedger: this.stats.lastProcessedLedger,
        lastProcessingMs: this.stats.lastProcessingMs,
        now: this.now(),
      });
    } catch (err) {
      this.deps.logger.warn("Verification worker: heartbeat failed", {
        workerId: this.workerId,
        error: describeError(err),
      });
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle().finally(() => this.scheduleNext(this.deps.config.pollIntervalMs));
    }, delayMs);
  }

  /**
   * Claims and processes up to `batchSize` due events. Returns the number
   * processed. Overlapping calls are rejected rather than run concurrently.
   */
  async runCycle(): Promise<number> {
    if (this.currentCycle) {
      this.deps.logger.warn("Verification worker: cycle skipped, previous cycle still running", {
        workerId: this.workerId,
      });
      return 0;
    }

    this.currentCycle = this.drainBatch();
    try {
      return await this.currentCycle;
    } finally {
      this.currentCycle = null;
    }
  }

  /**
   * Claims and processes up to `batchSize` events across `concurrency`
   * parallel lanes. Each claim is atomic, so lanes (and other workers) never
   * receive the same event.
   */
  private async drainBatch(): Promise<number> {
    let unclaimed = this.deps.config.batchSize;
    let processed = 0;

    const lane = async (): Promise<void> => {
      // Finish the event in hand on shutdown, but do not claim another.
      while (unclaimed > 0 && !this.stopRequested) {
        unclaimed -= 1;

        let event: IVerificationRequestEvent | null;
        try {
          event = await this.deps.queue.claim({
            workerId: this.workerId,
            leaseMs: this.deps.config.leaseMs,
            now: this.now(),
          });
        } catch (err) {
          this.deps.logger.error("Verification worker: failed to claim event", {
            workerId: this.workerId,
            error: describeError(err),
          });
          unclaimed = 0;
          return;
        }
        if (!event) {
          // Nothing is due; let the other lanes wind down too.
          unclaimed = 0;
          return;
        }

        await this.processEvent(event);
        processed += 1;
      }
    };

    const lanes = Math.max(1, Math.min(this.deps.config.concurrency, this.deps.config.batchSize));
    await Promise.all(Array.from({ length: lanes }, lane));
    await this.recordHeartbeat(this.running ? "running" : "stopping");
    return processed;
  }

  /** Runs one event to completion, retry, or failure. Never throws. */
  async processEvent(event: IVerificationRequestEvent): Promise<void> {
    const ctx = { workerId: this.workerId, eventId: event.eventId, attempt: event.attempts };
    let jobId = event.verificationJobId;
    const startedAt = process.hrtime.bigint();

    try {
      if (event.attempts > this.deps.config.maxAttempts) {
        throw new AppError(
          `Exceeded ${this.deps.config.maxAttempts} processing attempts`,
          500,
          "MAX_ATTEMPTS_EXCEEDED"
        );
      }

      this.deps.logger.info("Verification worker: processing event", ctx);
      const outcome = await this.advance(event, (id) => {
        jobId = id;
      });
      const durationMs = this.recordProcessed(startedAt, outcome === "rejected");
      this.deps.logger.info("Verification worker: event finished", { ...ctx, jobId, outcome, durationMs });
    } catch (err) {
      const settled = await this.handleFailure(event, jobId, err);
      const durationMs = this.recordProcessed(startedAt, settled === "dead-lettered");
      this.deps.logger.info("Verification worker: event attempt ended", {
        ...ctx,
        jobId,
        outcome: settled,
        durationMs,
      });
    }
  }

  /** Updates the telemetry counters for one finished attempt and returns its duration. */
  private recordProcessed(startedAt: bigint, failed: boolean): number {
    const durationMs = Math.round(elapsedMs(startedAt) * 1_000) / 1_000;
    this.stats.processed += 1;
    if (failed) this.stats.failed += 1;
    this.stats.lastProcessingMs = durationMs;
    return durationMs;
  }

  /** Drives the event's job from its current state to a terminal state. */
  private async advance(
    event: IVerificationRequestEvent,
    onJob: (jobId: string) => void
  ): Promise<"completed" | "rejected"> {
    const { events, jobs } = this.deps;
    let job: IVerificationJob | null = event.verificationJobId
      ? await jobs.getJob(event.verificationJobId)
      : null;

    if (job && isTerminal(job.status)) {
      return this.settleFromTerminalJob(event, job);
    }

    let manifestHash = event.manifestHash;

    // Stage 1: verification (fresh event, or crash before attestation).
    if (!job || job.status === VerificationStatus.PENDING || job.status === VerificationStatus.PROCESSING) {
      const result = await this.deps.verifier.verify({
        mediaCid: event.mediaCid,
        manifestCid: event.manifestCid,
        requester: event.requester,
      });

      if (!job) {
        job = await jobs.createJob({
          ownerPublicKey: event.requester,
          contentHash: result.contentHash,
          manifestHash: result.manifestHash,
          requestId: event.eventId,
        });
        await events.attachJob(event._id, this.workerId, String(job._id));
      }
      const id = String(job._id);
      onJob(id);
      await events.recordVerification(event._id, this.workerId, {
        contentHash: result.contentHash,
        manifestHash: result.manifestHash,
      });
      manifestHash = result.manifestHash;

      if (job.status === VerificationStatus.PENDING) {
        job = await jobs.updateJobStatus(id, { status: VerificationStatus.PROCESSING });
      }

      if (!result.verified) {
        const reason = `SPV verification failed: ${result.reason ?? "unknown reason"}`;
        await jobs.updateJobStatus(id, { status: VerificationStatus.FAILED, errorMessage: reason });
        await events.markFailed(event._id, this.workerId, reason);
        this.deps.logger.warn("Verification worker: verification rejected", {
          workerId: this.workerId,
          eventId: event.eventId,
          jobId: id,
          reason,
        });
        return "rejected";
      }

      const attestation = this.deps.attestations.createAttestation(
        {
          eventId: event.eventId,
          requester: event.requester,
          mediaCid: event.mediaCid,
          manifestCid: event.manifestCid,
          contentHash: result.contentHash,
          manifestHash: result.manifestHash,
        },
        this.deps.oracle.keypair,
        this.deps.oracle.codeMeasurementHash
      );

      job = await jobs.updateJobStatus(id, {
        status: VerificationStatus.TEE_VERIFYING,
        teeAttestationHash: attestation.attestationHash,
        teeSignature: attestation.signature,
        codeMeasurementHash: attestation.codeMeasurementHash,
      });
    }

    const id = String(job._id);
    onJob(id);

    // Stage 2: attestation transaction.
    if (job.status === VerificationStatus.TEE_VERIFYING) {
      if (!job.codeMeasurementHash) {
        throw new AppError(
          "Cannot submit attestation without a TEE measurement hash",
          409,
          "MISSING_TEE_MEASUREMENT"
        );
      }
      await this.deps.authorization?.assertAuthorized(
        job.codeMeasurementHash,
        this.deps.oracle.keypair.publicKey()
      );
      const txHash = await this.submitAttestation(event, job, manifestHash);
      job = await jobs.updateJobStatus(id, {
        status: VerificationStatus.MINTING,
        stellarTransactionHash: txHash,
      });
    }

    // Stage 3: finality. The job completes only after on-chain SUCCESS.
    if (job.status !== VerificationStatus.MINTING || !job.stellarTransactionHash) {
      throw new AppError(`Job ${id} is in unexpected state '${job.status}'`, 409, "UNEXPECTED_JOB_STATE");
    }

    const confirmed = await this.deps.soroban.getTransactionWithConfirmation(job.stellarTransactionHash);
    const certificateId =
      confirmed.returnValue !== undefined ? String(scValToNative(confirmed.returnValue)) : undefined;

    await jobs.updateJobStatus(id, {
      status: VerificationStatus.COMPLETED,
      ...(certificateId !== undefined ? { certificateId } : {}),
    });
    this.stats.lastProcessedLedger = confirmed.ledger;
    await events.markCompleted(event._id, this.workerId, {
      transactionHash: confirmed.txHash,
      ...(certificateId !== undefined ? { certificateId } : {}),
    });
    this.deps.logger.info("Verification worker: certificate minted", {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId: id,
      txHash: confirmed.txHash,
      ledger: confirmed.ledger,
      certificateId,
    });
    return "completed";
  }

  /**
   * Submits the mint transaction for a job in `tee_verifying` and returns
   * its hash once the RPC accepts it. If a previous attempt already submitted
   * a transaction, that transaction's outcome is resolved first so a
   * certificate is never minted twice.
   */
  private async submitAttestation(
    event: IVerificationRequestEvent,
    job: IVerificationJob,
    manifestHash: string | undefined
  ): Promise<string> {
    const { events, soroban, oracle } = this.deps;

    if (event.transactionHash) {
      try {
        await soroban.getTransactionWithConfirmation(event.transactionHash);
        return event.transactionHash;
      } catch (err) {
        if (!transactionDidNotLand(err)) throw err;
        this.deps.logger.warn("Verification worker: previous mint transaction did not land, rebuilding", {
          workerId: this.workerId,
          eventId: event.eventId,
          txHash: event.transactionHash,
          error: describeError(err),
        });
        await events.recordTransaction(event._id, this.workerId, null);
      }
    }

    if (!manifestHash || !job.teeAttestationHash) {
      throw new AppError(
        "Cannot build mint transaction: manifest hash or attestation hash missing",
        409,
        "MISSING_ATTESTATION_DATA"
      );
    }

    const signed = await soroban.buildMintTransaction(oracle.keypair, oracle.provenanceContractId, {
      to: event.requester,
      mediaCid: event.mediaCid,
      manifestHash,
      attestationHash: job.teeAttestationHash,
    });

    // Persist the hash before sending so a crash mid-submit can be resolved.
    await events.recordTransaction(event._id, this.workerId, signed.hash);
    try {
      await soroban.submitTransaction(signed);
    } catch (err) {
      if (err instanceof TransactionFailedError || err instanceof TransactionSubmissionError) {
        // Rejected before reaching a ledger: this hash can never land.
        await events.recordTransaction(event._id, this.workerId, null);
      }
      throw err;
    }

    this.deps.logger.info("Verification worker: mint transaction submitted", {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId: String(job._id),
      txHash: signed.hash,
    });
    return signed.hash;
  }

  private async settleFromTerminalJob(
    event: IVerificationRequestEvent,
    job: IVerificationJob
  ): Promise<"completed" | "rejected"> {
    if (job.status === VerificationStatus.COMPLETED && job.stellarTransactionHash) {
      await this.deps.events.markCompleted(event._id, this.workerId, {
        transactionHash: job.stellarTransactionHash,
      });
      return "completed";
    }
    await this.deps.events.markFailed(
      event._id,
      this.workerId,
      job.errorMessage ?? `Verification job ended in '${job.status}'`
    );
    return "rejected";
  }

  /**
   * Settles a failed attempt: a transient error is released back to the
   * queue with exponential back-off; anything else, or a transient error on
   * the last allowed attempt, fails the linked job and dead-letters the
   * request. Never throws.
   */
  private async handleFailure(
    event: IVerificationRequestEvent,
    jobId: string | undefined,
    err: unknown
  ): Promise<"retry-scheduled" | "dead-lettered" | "abandoned"> {
    const message = describeError(err);
    const errorCode = err instanceof AppError ? err.code : undefined;
    const retryable = isRetryableError(err);
    const ctx = {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId,
      attempt: event.attempts,
      error: message,
      ...(errorCode ? { code: errorCode } : {}),
      ...(err instanceof TransactionFailedError ? { diagnostics: err.diagnostics } : {}),
    };

    if (err instanceof LeaseLostError) {
      this.deps.logger.warn("Verification worker: lease lost, abandoning event", ctx);
      return "abandoned";
    }

    try {
      if (retryable && event.attempts < this.deps.config.maxAttempts) {
        const nextAttemptAt = new Date(
          this.now().getTime() + retryDelayMs(event.attempts, this.deps.config.retryBaseMs)
        );
        await this.deps.queue.release(event._id, this.workerId, nextAttemptAt, message);
        this.deps.logger.warn("Verification worker: retry scheduled", {
          ...ctx,
          nextAttemptAt: nextAttemptAt.toISOString(),
        });
        return "retry-scheduled";
      }

      await this.failJob(jobId, message);
      await this.deps.queue.deadLetter(
        event,
        this.workerId,
        { reason: message, ...(errorCode ? { errorCode } : {}), retryable, ...(jobId ? { jobId } : {}) },
        this.now()
      );
      this.deps.logger.error("Verification worker: event dead-lettered", ctx);
      return "dead-lettered";
    } catch (recordErr) {
      // The event stays leased; it is reclaimed once the lease expires.
      this.deps.logger.error("Verification worker: could not record failure", {
        ...ctx,
        recordError: describeError(recordErr),
      });
      return "abandoned";
    }
  }

  private async failJob(jobId: string | undefined, message: string): Promise<void> {
    if (!jobId) return;
    const job = await this.deps.jobs.getJob(jobId);
    if (isTerminal(job.status)) return;
    await this.deps.jobs.updateJobStatus(jobId, {
      status: VerificationStatus.FAILED,
      errorMessage: message,
    });
  }
}

/** Builds a worker wired to the production services and configuration. */
export function createVerificationWorker(): VerificationWorker {
  const oracle = loadOracleConfig();
  const queryClient = new SorobanContractQueryClient(oracle.keypair.publicKey());
  const authorization = new RegistryAuthorizationService(
    new RegistryContract(env.STELLAR_REGISTRY_CONTRACT_ID, queryClient),
    new OracleContract(env.STELLAR_ORACLE_CONTRACT_ID, queryClient)
  );

  return new VerificationWorker({
    queue: workerQueue,
    events: verificationRequestEventService,
    jobs: verificationService,
    verifier: spvVerifierService,
    attestations: attestationService,
    authorization,
    soroban: sorobanService,
    oracle,
    config: loadVerificationWorkerConfig(),
    logger,
    heartbeat: workerHeartbeatService,
  });
}

export interface ShutdownOptions {
  onStopped: () => Promise<void>;
  exit: (code: number) => void;
  forceExitAfterMs?: number;
}

/**
 * Installs SIGINT/SIGTERM handlers that stop the worker (letting the current
 * event finish), run `onStopped`, then exit. Returns an uninstaller.
 */
export function installShutdownHandlers(
  worker: VerificationWorker,
  { onStopped, exit, forceExitAfterMs = 30_000 }: ShutdownOptions
): () => void {
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Verification worker: shutdown signal received", { signal, workerId: worker.id });

    setTimeout(() => {
      logger.error("Verification worker: forced exit after shutdown timeout", { workerId: worker.id });
      exit(1);
    }, forceExitAfterMs).unref();

    void worker
      .stop()
      .then(onStopped)
      .then(() => exit(0))
      .catch((err: unknown) => {
        logger.error("Verification worker: error during shutdown", { error: describeError(err) });
        exit(1);
      });
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function main(): Promise<void> {
  const worker = createVerificationWorker();
  await connectDatabase();
  installShutdownHandlers(worker, {
    onStopped: disconnectDatabase,
    exit: (code) => process.exit(code),
  });
  worker.start();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error("Verification worker: fatal startup error", { error: describeError(err) });
    process.exit(1);
  });
}
