import mongoose, { Schema, Document } from 'mongoose';

/**
 * APIKeyUsage Interface
 * Represents aggregated API usage metrics for a single API key, grouped by hour, endpoint, method, and status code.
 * 
 * One document per unique (apiKeyId, endpoint, method, statusCode, hour) tuple.
 * The count field is incremented atomically for concurrent requests.
 */
export interface IAPIKeyUsage extends Document {
  apiKeyId: string;          // SHA-256 hashed API key identifier (tied to User.apiKeys array)
  endpoint: string;          // Normalized route pattern, e.g., /api/v1/certificates/:id
  method: string;            // HTTP method: GET, POST, PUT, DELETE, PATCH
  statusCode: number;        // HTTP response status code
  hour: Date;                // UTC start of the hour (e.g., 2024-01-15T14:00:00.000Z)
  count: number;             // Number of requests in this bucket
  firstSeenAt: Date;         // Timestamp of the first request in this bucket
  lastSeenAt: Date;          // Timestamp of the most recent request in this bucket
  createdAt: Date;
  updatedAt: Date;
}

const APIKeyUsageSchema: Schema = new Schema(
  {
    apiKeyId: {
      type: String,
      required: [true, 'API key ID is required'],
      index: true,
    },
    endpoint: {
      type: String,
      required: [true, 'Endpoint is required'],
      index: true,
    },
    method: {
      type: String,
      required: [true, 'HTTP method is required'],
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    },
    statusCode: {
      type: Number,
      required: [true, 'Status code is required'],
      min: 100,
      max: 599,
    },
    hour: {
      type: Date,
      required: [true, 'Hour bucket is required'],
      index: true,
    },
    count: {
      type: Number,
      required: [true, 'Count is required'],
      default: 1,
      min: 1,
    },
    firstSeenAt: {
      type: Date,
      required: [true, 'First seen timestamp is required'],
    },
    lastSeenAt: {
      type: Date,
      required: [true, 'Last seen timestamp is required'],
    },
  },
  { timestamps: true }
);

// ── Compound unique index for the aggregation bucket ──────────────────────────
// Ensures only one document per (apiKeyId, endpoint, method, statusCode, hour) tuple.
APIKeyUsageSchema.index(
  { apiKeyId: 1, endpoint: 1, method: 1, statusCode: 1, hour: 1 },
  { unique: true, name: 'idx_usage_bucket_unique' }
);

// ── Index for per-key time-range queries ──────────────────────────────────────
// Allows efficient queries like: find usage for keyId between dates.
APIKeyUsageSchema.index(
  { apiKeyId: 1, hour: -1 },
  { name: 'idx_usage_key_time' }
);

// ── TTL Index: automatically delete documents older than 90 days ───────────────
// Usage records are retained for 90 days by default. This can be configured
// via API_USAGE_RETENTION_DAYS in environment config.
APIKeyUsageSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60, // 90 days
    name: 'idx_usage_ttl',
  }
);

export default mongoose.model<IAPIKeyUsage>('APIKeyUsage', APIKeyUsageSchema);
