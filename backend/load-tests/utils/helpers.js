/**
 * Load Test Helper Functions
 * Shared utilities for load tests
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { config, getApiUrl, getAuthHeaders } from './config.js';

/**
 * Validates that transaction is atomic (all or nothing)
 * Checks response contains expected transaction metadata
 */
export function validateTransactionAtomicity(response, transactionId) {
  return check(response, {
    'status is 200': (r) => r.status === 200,
    'transaction committed': (r) => r.body.indexOf('"success":true') !== -1,
    'transaction id matches': (r) => r.body.indexOf(transactionId) !== -1,
    'has transaction metadata': (r) => r.body.indexOf('"data"') !== -1,
  });
}

/**
 * Validates worker idempotency
 * Ensures that duplicate requests return the same result
 */
export function validateWorkerIdempotency(firstResponse, duplicateResponse) {
  return check(duplicateResponse, {
    'status is 200': (r) => r.status === 200,
    'response matches first request': (r) => {
      try {
        const firstBody = JSON.parse(firstResponse.body);
        const duplicateBody = JSON.parse(r.body);
        
        // Compare key fields that should match
        return (
          firstBody.data?.jobId === duplicateBody.data?.jobId &&
          firstBody.data?.status === duplicateBody.data?.status
        );
      } catch (e) {
        return false;
      }
    },
    'no duplicate processing': (r) => {
      try {
        const body = JSON.parse(r.body);
        // Check that job wasn't processed twice
        return body.data?.processCount <= 1;
      } catch (e) {
        return false;
      }
    },
  });
}

/**
 * Makes a KMS rotation request
 */
export function rotateKmsKey(userId) {
  const url = getApiUrl(config.endpoints.kms.rotate(userId));
  const response = http.post(url, null, {
    headers: getAuthHeaders(),
    tags: { name: 'KmsRotate' },
  });

  return response;
}

/**
 * Gets all KMS keys for a user
 */
export function getAllKmsKeys(userId) {
  const url = getApiUrl(config.endpoints.kms.keys(userId));
  const response = http.get(url, {
    headers: getAuthHeaders(),
    tags: { name: 'KmsGetAllKeys' },
  });

  return response;
}

/**
 * Gets active KMS key for a user
 */
export function getActiveKmsKey(userId) {
  const url = getApiUrl(config.endpoints.kms.activeKey(userId));
  const response = http.get(url, {
    headers: getAuthHeaders(),
    tags: { name: 'KmsGetActiveKey' },
  });

  return response;
}

/**
 * Revokes a KMS key
 */
export function revokeKmsKey(keyId) {
  const url = getApiUrl(config.endpoints.kms.revokeKey(keyId));
  const response = http.del(url, null, {
    headers: getAuthHeaders(),
    tags: { name: 'KmsRevokeKey' },
  });

  return response;
}

/**
 * Gets verification job status
 */
export function getVerificationJobStatus(jobId) {
  const url = getApiUrl(config.endpoints.verification.jobStatus(jobId));
  const response = http.get(url, {
    headers: getAuthHeaders(),
    tags: { name: 'GetJobStatus' },
  });

  return response;
}

/**
 * Parses response and extracts relevant ID
 */
export function extractIdFromResponse(response) {
  try {
    const body = JSON.parse(response.body);
    return body.data?.id || body.data?._id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Simulates realistic user think time
 */
export function thinkTime(minMs = 100, maxMs = 500) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  sleep(delay / 1000);
}

/**
 * Groups related requests for better metrics
 */
export function runGroupedRequests(groupName, requestFn) {
  return group(groupName, requestFn);
}

/**
 * Validates response consistency for idempotency
 */
export function compareResponses(response1, response2) {
  try {
    const body1 = JSON.parse(response1.body);
    const body2 = JSON.parse(response2.body);

    // Extract and compare core data
    const data1 = body1.data || {};
    const data2 = body2.data || {};

    return {
      sameJobId: data1.jobId === data2.jobId,
      sameStatus: data1.status === data2.status,
      sameResult: JSON.stringify(data1) === JSON.stringify(data2),
      duplicateDetected: data1.duplicateMarker === true,
    };
  } catch (e) {
    return { error: true };
  }
}

/**
 * Generates unique transaction ID for tracking
 */
export function generateTransactionId() {
  return `txn-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Retries a request with exponential backoff
 */
export function retryWithBackoff(requestFn, maxRetries = 3) {
  let response = null;
  let lastError = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      response = requestFn();
      if (response.status === 200 || response.status === 201) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    // Exponential backoff: 100ms, 200ms, 400ms
    const backoffMs = Math.pow(2, i) * 100;
    sleep(backoffMs / 1000);
  }

  throw new Error(`Request failed after ${maxRetries} retries: ${lastError}`);
}
