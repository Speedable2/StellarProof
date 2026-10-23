/**
 * Worker queue (issue #694) and dead-lettering (issue #693) against a real
 * MongoDB (mongodb-memory-server): concurrent claims never hand the same
 * request to two workers, released requests come back on schedule, and
 * dead-lettered requests land in `deadLetteredRequests`.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import { Keypair } from "@stellar/stellar-sdk";
import { MongoMemoryServer } from "mongodb-memory-server";

import { MongoWorkerQueue } from "../workerQueue.service";
import { LeaseLostError } from "../verificationRequestEvent.service";
import { VerificationRequestEventModel } from "../../models/verificationRequestEvent.model";
import { DeadLetteredRequestModel } from "../../models/DeadLetteredRequest.model";
import {
  VerificationRequestEventStatus,
  type IVerificationRequestEvent,
} from "../../types/verificationRequestEvent.types";

const MEDIA_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const MANIFEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const LEASE_MS = 60_000;

const queue = new MongoWorkerQueue();

async function enqueue(count: number, now: Date): Promise<string[]> {
  const docs = await VerificationRequestEventModel.insertMany(
    Array.from({ length: count }, () => ({
      eventId: `evt-${crypto.randomBytes(6).toString("hex")}`,
      mediaCid: MEDIA_CID,
      manifestCid: MANIFEST_CID,
      requester: Keypair.random().publicKey(),
      nextAttemptAt: now,
    }))
  );
  return docs.map((doc) => doc.eventId);
}

async function claimAll(workerId: string, now: Date): Promise<IVerificationRequestEvent[]> {
  const claimed: IVerificationRequestEvent[] = [];
  for (;;) {
    const event = await queue.claim({ workerId, leaseMs: LEASE_MS, now });
    if (!event) return claimed;
    claimed.push(event);
  }
}

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([VerificationRequestEventModel.syncIndexes(), DeadLetteredRequestModel.syncIndexes()]);
});

afterEach(async () => {
  await Promise.all([VerificationRequestEventModel.deleteMany({}), DeadLetteredRequestModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("MongoWorkerQueue.claim", () => {
  it("hands every due request to exactly one of many concurrent workers", async () => {
    const now = new Date();
    const enqueued = await enqueue(40, now);
    const workers = Array.from({ length: 8 }, (_, i) => `worker-${i}`);

    const results = await Promise.all(workers.map((workerId) => claimAll(workerId, now)));

    const claimedIds = results.flat().map((event) => event.eventId);
    expect(claimedIds).toHaveLength(enqueued.length);
    expect(new Set(claimedIds)).toEqual(new Set(enqueued));
    results.forEach((claimed, i) => {
      for (const event of claimed) {
        expect(event.lockedBy).toBe(workers[i]);
      }
    });
    const stored = await VerificationRequestEventModel.find().lean();
    expect(stored.every((event) => event.status === VerificationRequestEventStatus.PROCESSING)).toBe(true);
  });

  it("does not hand out a request whose lease is still held", async () => {
    const now = new Date();
    await enqueue(1, now);

    await expect(queue.claim({ workerId: "a", leaseMs: LEASE_MS, now })).resolves.not.toBeNull();
    await expect(queue.claim({ workerId: "b", leaseMs: LEASE_MS, now })).resolves.toBeNull();
  });

  it("lets another worker reclaim a request once the holder's lease expires", async () => {
    const now = new Date();
    const [eventId] = await enqueue(1, now);
    await queue.claim({ workerId: "crashed", leaseMs: LEASE_MS, now });

    const later = new Date(now.getTime() + LEASE_MS + 1);
    const reclaimed = await queue.claim({ workerId: "survivor", leaseMs: LEASE_MS, now: later });

    expect(reclaimed).toMatchObject({ eventId, lockedBy: "survivor", attempts: 2 });
  });
});

describe("MongoWorkerQueue.release", () => {
  it("returns the request to the queue for its retry time only", async () => {
    const now = new Date();
    await enqueue(1, now);
    const claimed = await queue.claim({ workerId: "a", leaseMs: LEASE_MS, now });
    const retryAt = new Date(now.getTime() + 30_000);

    await queue.release(claimed!._id, "a", retryAt, "gateway timeout");

    await expect(queue.claim({ workerId: "b", leaseMs: LEASE_MS, now })).resolves.toBeNull();
    await expect(queue.claim({ workerId: "b", leaseMs: LEASE_MS, now: retryAt })).resolves.toMatchObject({
      _id: claimed!._id,
      lockedBy: "b",
      lastError: "gateway timeout",
    });
  });

  it("refuses to release a request the caller no longer holds", async () => {
    const now = new Date();
    await enqueue(1, now);
    const claimed = await queue.claim({ workerId: "a", leaseMs: LEASE_MS, now });

    await expect(queue.release(claimed!._id, "someone-else", now, "x")).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("MongoWorkerQueue.deadLetter", () => {
  async function claimOne(workerId = "worker-1"): Promise<IVerificationRequestEvent> {
    const now = new Date();
    await enqueue(1, now);
    const claimed = await queue.claim({ workerId, leaseMs: LEASE_MS, now });
    if (!claimed) throw new Error("nothing to claim");
    return claimed;
  }

  it("stores the request in deadLetteredRequests and marks it failed", async () => {
    const event = await claimOne();
    const jobId = new mongoose.Types.ObjectId().toString();
    const now = new Date();

    await queue.deadLetter(
      event,
      "worker-1",
      { reason: "Exceeded 3 processing attempts", errorCode: "MAX_ATTEMPTS_EXCEEDED", retryable: false, jobId },
      now
    );

    const entry = await DeadLetteredRequestModel.findOne({ eventId: event.eventId }).lean();
    expect(entry).toMatchObject({
      eventId: event.eventId,
      mediaCid: MEDIA_CID,
      manifestCid: MANIFEST_CID,
      requester: event.requester,
      attempts: 1,
      reason: "Exceeded 3 processing attempts",
      errorCode: "MAX_ATTEMPTS_EXCEEDED",
      retryable: false,
      workerId: "worker-1",
      deadLetteredAt: now,
    });
    expect(String(entry?.requestEventId)).toBe(event._id);
    expect(String(entry?.verificationJobId)).toBe(jobId);
    expect(DeadLetteredRequestModel.collection.collectionName).toBe("deadLetteredRequests");

    const stored = await VerificationRequestEventModel.findById(event._id).lean();
    expect(stored).toMatchObject({
      status: VerificationRequestEventStatus.FAILED,
      lastError: "Exceeded 3 processing attempts",
    });
    expect(stored?.lockedBy).toBeUndefined();
  });

  it("is idempotent when a crashed attempt already wrote the dead letter", async () => {
    const event = await claimOne();
    await DeadLetteredRequestModel.create({
      eventId: event.eventId,
      requestEventId: event._id,
      mediaCid: event.mediaCid,
      manifestCid: event.manifestCid,
      requester: event.requester,
      attempts: event.attempts,
      reason: "first try",
      retryable: true,
      workerId: "worker-1",
      deadLetteredAt: new Date(),
    });

    await queue.deadLetter(event, "worker-1", { reason: "second try", retryable: true });

    await expect(DeadLetteredRequestModel.countDocuments({ eventId: event.eventId })).resolves.toBe(1);
    const stored = await VerificationRequestEventModel.findById(event._id).lean();
    expect(stored?.status).toBe(VerificationRequestEventStatus.FAILED);
  });

  it("leaves no dead letter behind when the caller has lost the lease", async () => {
    const event = await claimOne("worker-1");

    await expect(
      queue.deadLetter(event, "worker-2", { reason: "not mine", retryable: false })
    ).rejects.toBeInstanceOf(LeaseLostError);

    await expect(DeadLetteredRequestModel.countDocuments()).resolves.toBe(0);
    const stored = await VerificationRequestEventModel.findById(event._id).lean();
    expect(stored).toMatchObject({ status: VerificationRequestEventStatus.PROCESSING, lockedBy: "worker-1" });
  });
});
