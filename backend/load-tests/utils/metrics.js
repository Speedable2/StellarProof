/**
 * Custom Metrics for Load Tests
 * Track specific business logic metrics beyond standard HTTP metrics
 */

import { Counter, Trend, Gauge, Rate } from 'k6/metrics';

// KMS Rotation Metrics
export const kmsRotationCounter = new Counter('kms_rotations_total');
export const kmsRotationSuccessRate = new Rate('kms_rotation_success');
export const kmsRotationDuration = new Trend('kms_rotation_duration_ms');
export const kmsAtomicityViolations = new Counter('kms_atomicity_violations');
export const kmsTransactionErrors = new Counter('kms_transaction_errors');
export const kmsReEncryptedAssets = new Trend('kms_re_encrypted_assets');

// Worker Idempotency Metrics
export const workerRequestsCounter = new Counter('worker_requests_total');
export const workerIdempotencySuccessRate = new Rate('worker_idempotency_success');
export const workerDuplicateHandledRate = new Rate('worker_duplicate_handled');
export const workerIdempotencyViolations = new Counter('worker_idempotency_violations');
export const workerProcessingTime = new Trend('worker_processing_time_ms');
export const workerDuplicateRequests = new Counter('worker_duplicate_requests');

// Concurrency Metrics
export const concurrentOperations = new Gauge('concurrent_operations');
export const queuedOperations = new Counter('queued_operations');
export const operationWaitTime = new Trend('operation_wait_time_ms');

// Database Transaction Metrics
export const dbTransactionsTotal = new Counter('db_transactions_total');
export const dbTransactionSuccessRate = new Rate('db_transaction_success');
export const dbTransactionDuration = new Trend('db_transaction_duration_ms');
export const dbLockContention = new Trend('db_lock_contention_ms');

// Error Metrics
export const errorCounter = new Counter('errors_total');
export const timeoutCounter = new Counter('timeouts_total');
export const networkErrorCounter = new Counter('network_errors_total');

/**
 * Records a successful KMS rotation
 */
export function recordKmsRotationSuccess(durationMs, assetsCount) {
  kmsRotationCounter.add(1);
  kmsRotationSuccessRate.add(1);
  kmsRotationDuration.add(durationMs);
  if (assetsCount) {
    kmsReEncryptedAssets.add(assetsCount);
  }
}

/**
 * Records a KMS rotation failure
 */
export function recordKmsRotationFailure(errorType) {
  kmsRotationCounter.add(1);
  kmsRotationSuccessRate.add(0);
  
  if (errorType === 'atomicity') {
    kmsAtomicityViolations.add(1);
  } else if (errorType === 'transaction') {
    kmsTransactionErrors.add(1);
  }
}

/**
 * Records a worker request
 */
export function recordWorkerRequest(isDuplicate = false, processingTimeMs = 0) {
  workerRequestsCounter.add(1);
  
  if (isDuplicate) {
    workerDuplicateRequests.add(1);
  }

  if (processingTimeMs > 0) {
    workerProcessingTime.add(processingTimeMs);
  }
}

/**
 * Records worker idempotency success
 */
export function recordWorkerIdempotencySuccess(isDuplicateHandledCorrectly = true) {
  workerIdempotencySuccessRate.add(1);
  
  if (isDuplicateHandledCorrectly) {
    workerDuplicateHandledRate.add(1);
  }
}

/**
 * Records worker idempotency failure
 */
export function recordWorkerIdempotencyFailure() {
  workerIdempotencySuccessRate.add(0);
  workerIdempotencyViolations.add(1);
}

/**
 * Records concurrent operations count
 */
export function recordConcurrentOperation(count) {
  concurrentOperations.set(count);
}

/**
 * Records database transaction metrics
 */
export function recordDbTransaction(durationMs, success = true, lockContentionMs = 0) {
  dbTransactionsTotal.add(1);
  dbTransactionSuccessRate.add(success ? 1 : 0);
  dbTransactionDuration.add(durationMs);
  
  if (lockContentionMs > 0) {
    dbLockContention.add(lockContentionMs);
  }
}

/**
 * Records an error
 */
export function recordError(errorType) {
  errorCounter.add(1);
  
  if (errorType === 'timeout') {
    timeoutCounter.add(1);
  } else if (errorType === 'network') {
    networkErrorCounter.add(1);
  }
}

/**
 * Generates a metrics summary
 */
export function getMetricsSummary() {
  return {
    kms: {
      totalRotations: kmsRotationCounter.value,
      successRate: kmsRotationSuccessRate.value,
      atomicityViolations: kmsAtomicityViolations.value,
      transactionErrors: kmsTransactionErrors.value,
    },
    worker: {
      totalRequests: workerRequestsCounter.value,
      successRate: workerIdempotencySuccessRate.value,
      idempotencyViolations: workerIdempotencyViolations.value,
      duplicateRequests: workerDuplicateRequests.value,
    },
    errors: {
      totalErrors: errorCounter.value,
      timeouts: timeoutCounter.value,
      networkErrors: networkErrorCounter.value,
    },
  };
}
