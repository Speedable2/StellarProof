/**
 * Load Test Configuration
 * Centralized configuration for load test scenarios
 */

export const config = {
  baseUrl: __ENV.BASE_URL || 'http://localhost:4000',
  apiVersion: 'v1',
  
  // Authentication
  auth: {
    defaultUserId: __ENV.TEST_USER_ID || 'test-user-001',
    jwtToken: __ENV.JWT_TOKEN || '',
  },

  // KMS Load Test Configuration
  kms: {
    // Concurrency test parameters
    concurrency: {
      vus: parseInt(__ENV.KMS_VUS || '50', 10),
      duration: __ENV.KMS_DURATION || '5m',
      rampUp: parseInt(__ENV.KMS_RAMP_UP || '1m', 10),
    },
    // Users to test rotation on
    testUserIds: [
      'load-test-kms-001',
      'load-test-kms-002',
      'load-test-kms-003',
      'load-test-kms-004',
      'load-test-kms-005',
    ],
    // Batch configuration
    batch: {
      size: parseInt(__ENV.KMS_BATCH_SIZE || '5', 10),
      concurrentBatches: parseInt(__ENV.KMS_CONCURRENT_BATCHES || '10', 10),
    },
  },

  // Worker Idempotency Test Configuration
  worker: {
    // Concurrency test parameters
    concurrency: {
      vus: parseInt(__ENV.WORKER_VUS || '50', 10),
      duration: __ENV.WORKER_DURATION || '5m',
      rampUp: parseInt(__ENV.WORKER_RAMP_UP || '1m', 10),
    },
    // Number of duplicate requests to send
    duplicateRequests: parseInt(__ENV.WORKER_DUPLICATE_REQUESTS || '5', 10),
    // Delay between duplicate requests (ms)
    duplicateDelay: parseInt(__ENV.WORKER_DUPLICATE_DELAY || '100', 10),
  },

  // Thresholds for pass/fail criteria
  thresholds: {
    http: {
      successRate: 0.95,      // 95% of requests should succeed
      p95ResponseTime: 5000,  // 95th percentile response time < 5s
      p99ResponseTime: 10000, // 99th percentile response time < 10s
    },
    kms: {
      atomicityFailures: 0,   // Zero atomicity failures allowed
      transactionErrors: 0,   // Zero transaction errors allowed
    },
    worker: {
      idempotencyFailures: 0, // Zero idempotency failures allowed
      duplicateHandling: 1.0, // All duplicates should be handled correctly
    },
  },

  // Endpoints
  endpoints: {
    kms: {
      rotate: (userId) => `/api/${config.apiVersion}/kms/rotate/${userId}`,
      keys: (userId) => `/api/${config.apiVersion}/kms/keys/${userId}`,
      activeKey: (userId) => `/api/${config.apiVersion}/kms/keys/${userId}/active`,
      revokeKey: (keyId) => `/api/${config.apiVersion}/kms/keys/${keyId}`,
    },
    verification: {
      jobs: `/api/${config.apiVersion}/verification/jobs`,
      jobStatus: (jobId) => `/api/${config.apiVersion}/verification/jobs/${jobId}`,
    },
  },
};

export function getApiUrl(endpoint) {
  return `${config.baseUrl}${endpoint}`;
}

export function getAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.auth.jwtToken) {
    headers['Authorization'] = `Bearer ${config.auth.jwtToken}`;
  }

  return headers;
}
