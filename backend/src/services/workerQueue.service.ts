/**
 * Work queue the verification worker pulls requests from.
 *
 * `WorkerQueue` is the contract a worker relies on to scale horizontally:
 * `claim` hands each due request to exactly one worker, `release` returns it
 * for a later retry, and `deadLetter` quarantines a request that will never
 * succeed. Any number of worker processes (and lanes within a process) can
 * share one queue.
 *
 * `MongoWorkerQueue` keeps requests in MongoDB. A claim is a single atomic
 * `findOneAndUpdate` that takes a time-limited lease, so two workers can
 * never hold the same request; a request whose worker died is reclaimed once
 * its lease expires. Every later write is guarded by that lease.
 */
import mongoose from "mongoose";
import { DeadLetteredRequestModel } from "../models/DeadLetteredRequest.model";
import {
  verificationRequestEventService,
  type ClaimOptions,
  type VerificationRequestEventServiceType,
} from "./verificationRequestEvent.service";
import type { IVerificationRequestEvent } from "../types/verificationRequestEvent.types";

export interface DeadLetterInput {
  reason: string;
  /** Application error code of the final failure, when it had one. */
  errorCode?: string;
  /** Whether the final failure was transient (i.e. retries ran out). */
  retryable: boolean;
  /** Verification job linked to the request, when one was created. */
  jobId?: string;
}

export interface WorkerQueue {
  /** Atomically claims the next due request for `workerId`, or returns null. */
  claim(options: ClaimOptions): Promise<IVerificationRequestEvent | null>;
  /** Releases a claimed request so it can be claimed again at `retryAt`. */
  release(eventId: string, workerId: string, retryAt: Date, reason: string): Promise<void>;
  /**
   * Moves a claimed request to the dead-letter collection and marks it
   * failed. Idempotent per request.
   */
  deadLetter(
    event: IVerificationRequestEvent,
    workerId: string,
    input: DeadLetterInput,
    now?: Date
  ): Promise<void>;
}

type QueueEvents = Pick<VerificationRequestEventServiceType, "claimNext" | "scheduleRetry" | "markFailed">;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 11000;
}

export class MongoWorkerQueue implements WorkerQueue {
  constructor(private readonly events: QueueEvents = verificationRequestEventService) {}

  claim(options: ClaimOptions): Promise<IVerificationRequestEvent | null> {
    return this.events.claimNext(options);
  }

  release(eventId: string, workerId: string, retryAt: Date, reason: string): Promise<void> {
    return this.events.scheduleRetry(eventId, workerId, retryAt, reason);
  }

  async deadLetter(
    event: IVerificationRequestEvent,
    workerId: string,
    input: DeadLetterInput,
    now: Date = new Date()
  ): Promise<void> {
    const jobId = input.jobId ?? event.verificationJobId;
    let insertedId: mongoose.Types.ObjectId | null = null;
    try {
      const entry = await DeadLetteredRequestModel.create({
        eventId: event.eventId,
        requestEventId: new mongoose.Types.ObjectId(event._id),
        ...(jobId && mongoose.Types.ObjectId.isValid(jobId)
          ? { verificationJobId: new mongoose.Types.ObjectId(jobId) }
          : {}),
        mediaCid: event.mediaCid,
        manifestCid: event.manifestCid,
        requester: event.requester,
        attempts: event.attempts,
        reason: input.reason,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        retryable: input.retryable,
        workerId,
        deadLetteredAt: now,
      });
      insertedId = entry._id as mongoose.Types.ObjectId;
    } catch (err) {
      // Already dead-lettered by an earlier attempt that crashed afterwards.
      if (!isDuplicateKeyError(err)) throw err;
    }

    try {
      await this.events.markFailed(event._id, workerId, input.reason);
    } catch (err) {
      // Without the lease the request belongs to another worker, so it must
      // not stay in the dead-letter collection on this worker's say-so.
      if (insertedId) await DeadLetteredRequestModel.deleteOne({ _id: insertedId });
      throw err;
    }
  }
}

export const workerQueue: WorkerQueue = new MongoWorkerQueue();
