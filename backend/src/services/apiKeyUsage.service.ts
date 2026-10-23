import APIKeyUsage, { IAPIKeyUsage } from '../models/APIKeyUsage.model';
import { AppError } from '../errors/AppError';
import { env } from '../config/env';

/**
 * Request usage record parameters.
 */
export interface RecordUsageParams {
  apiKeyId: string;       // SHA-256 hashed API key
  endpoint: string;       // Normalized route pattern, e.g., /api/v1/certificates/:id
  method: string;         // HTTP method (GET, POST, etc.)
  statusCode: number;     // HTTP response status code
  timestamp?: Date;       // Request timestamp (defaults to now)
}

/**
 * Usage query parameters.
 */
export interface GetUsageParams {
  from?: Date;            // Start of time range (defaults to 24h ago)
  to?: Date;              // End of time range (defaults to now)
  endpoint?: string;      // Optional: filter by specific endpoint
  granularity?: 'hour' | 'day'; // Aggregation level (defaults to 'hour')
  limit?: number;         // Max results for paginated queries
  skip?: number;          // Offset for pagination
}

/**
 * Per-endpoint usage summary.
 */
export interface EndpointUsageSummary {
  endpoint: string;
  method: string;
  totalRequests: number;
  statusCodeBreakdown: {
    [statusCode: number]: number;
  };
}

/**
 * Hourly usage data point.
 */
export interface HourlyUsageData {
  hour: Date;
  requests: number;
  statusCodeBreakdown: {
    [statusCode: number]: number;
  };
}

/**
 * API key usage aggregation result.
 */
export interface UsageAggregation {
  apiKeyId: string;
  period: {
    from: Date;
    to: Date;
  };
  totalRequests: number;
  byEndpoint: EndpointUsageSummary[];
  byStatusCode: {
    [statusCode: number]: number;
  };
  hourlyBreakdown: HourlyUsageData[];
}

/**
 * APIKeyUsageService
 * Handles all database operations for API key usage metering.
 * All methods are strongly typed and production-ready.
 */
export class APIKeyUsageService {
  /**
   * Compute the UTC start of the hour for a given timestamp.
   * E.g., 2024-01-15T14:37:22.000Z → 2024-01-15T14:00:00.000Z
   */
  private getHourBucket(timestamp: Date = new Date()): Date {
    const date = new Date(timestamp);
    date.setUTCMinutes(0, 0, 0);
    return date;
  }

  /**
   * Record a single API request atomically.
   * Uses findOneAndUpdate with upsert to ensure concurrent requests never lose counts.
   * 
   * @param params - Request usage parameters
   * @throws AppError on database errors
   */
  async recordUsage(params: RecordUsageParams): Promise<void> {
    try {
      const { apiKeyId, endpoint, method, statusCode, timestamp } = params;

      // Validate input
      if (!apiKeyId || !endpoint || !method || !statusCode) {
        throw new AppError(
          'Missing required usage record parameters',
          500,
          'INVALID_USAGE_RECORD'
        );
      }

      const hour = this.getHourBucket(timestamp);
      const now = new Date();

      // Atomic upsert: increment count if bucket exists, create if not
      await APIKeyUsage.findOneAndUpdate(
        {
          apiKeyId,
          endpoint,
          method: method.toUpperCase(),
          statusCode,
          hour,
        },
        {
          $inc: { count: 1 },
          $set: { lastSeenAt: now },
          $setOnInsert: {
            firstSeenAt: now,
            count: 1,
          },
        },
        {
          upsert: true,
          new: true,
          // Don't run validators on upsert to avoid schema validation delays
          runValidators: false,
        }
      ).exec();
    } catch (error: unknown) {
      // Log the error but don't throw—metering failures must never affect API responses
      console.error('[APIKeyUsage] Failed to record usage:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Get total usage for the current period (hour or day).
   * Used for quota enforcement and real-time rate limiting.
   * 
   * @param apiKeyId - Hashed API key identifier
   * @param periodStart - Start of the current period (hour or day)
   * @returns Total request count or 0 if no usage found
   */
  async getCurrentPeriodTotal(
    apiKeyId: string,
    periodStart: Date
  ): Promise<number> {
    try {
      const result = await APIKeyUsage.aggregate<{ total: number }>([
        {
          $match: {
            apiKeyId,
            hour: { $gte: periodStart },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$count' },
          },
        },
      ]).exec();

      return result[0]?.total ?? 0;
    } catch (error: unknown) {
      console.error('[APIKeyUsage] Failed to get current period total:', error instanceof Error ? error.message : error);
      throw new AppError(
        'Failed to retrieve current usage total',
        500,
        'USAGE_QUERY_FAILED'
      );
    }
  }

  /**
   * Retrieve aggregated usage for an API key over a time range.
   * Returns totals, per-endpoint breakdown, per-status-code breakdown, and hourly series.
   * 
   * @param apiKeyId - Hashed API key identifier
   * @param params - Query parameters (from, to, endpoint filter, granularity, pagination)
   * @returns Aggregated usage data with multiple breakdowns
   * @throws AppError on validation or query errors
   */
  async getUsageByKey(
    apiKeyId: string,
    params: GetUsageParams = {}
  ): Promise<UsageAggregation> {
    try {
      // ── Validate and normalize parameters ──────────────────────────────────
      const maxQueryWindowDays = env.API_USAGE_MAX_QUERY_WINDOW_DAYS || 90;
      const defaultRangeDays = env.API_USAGE_DEFAULT_RANGE_DAYS || 7;

      const to = params.to ? new Date(params.to) : new Date();
      const from = params.from
        ? new Date(params.from)
        : new Date(to.getTime() - defaultRangeDays * 24 * 60 * 60 * 1000);

      // Enforce maximum query window
      const windowDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      if (windowDays > maxQueryWindowDays) {
        throw new AppError(
          `Query window exceeds maximum of ${maxQueryWindowDays} days`,
          400,
          'QUERY_WINDOW_TOO_LARGE'
        );
      }

      if (from >= to) {
        throw new AppError(
          'Query start date must be before end date',
          400,
          'INVALID_DATE_RANGE'
        );
      }

      const endpoint = params.endpoint;
      const granularity = params.granularity ?? 'hour';
      const limit = Math.min(params.limit ?? 1000, 10000); // Cap pagination at 10k
      const skip = params.skip ?? 0;

      // ── Build aggregation pipeline ────────────────────────────────────────

      const match: Record<string, unknown> = {
        apiKeyId,
        hour: { $gte: from, $lte: to },
      };

      if (endpoint) {
        match.endpoint = endpoint;
      }

      const pipeline: Parameters<typeof APIKeyUsage.aggregate>[0] = [
        { $match: match },

        // ── Stage 1: Per-endpoint breakdown ────────────────────────────────
        {
          $group: {
            _id: {
              endpoint: '$endpoint',
              method: '$method',
              statusCode: '$statusCode',
              hour: '$hour',
            },
            count: { $sum: '$count' },
          },
        },

        // ── Stage 2: Build per-endpoint and per-status summaries ──────────
        {
          $group: {
            _id: {
              endpoint: '$_id.endpoint',
              method: '$_id.method',
            },
            totalRequests: { $sum: '$count' },
            statusCodes: {
              $push: {
                code: '$_id.statusCode',
                count: '$count',
              },
            },
            hours: {
              $push: {
                hour: '$_id.hour',
                count: '$count',
                statusCode: '$_id.statusCode',
              },
            },
          },
        },

        // ── Stage 3: Transform into output shape ──────────────────────────
        {
          $project: {
            endpoint: '$_id.endpoint',
            method: '$_id.method',
            totalRequests: 1,
            statusCodeBreakdown: {
              $arrayToObject: {
                $map: {
                  input: '$statusCodes',
                  as: 'sc',
                  in: ['$$sc.code', '$$sc.count'],
                },
              },
            },
            hours: 1,
            _id: 0,
          },
        },

        // ── Stage 4: Sort by total requests (most used first) ──────────────
        { $sort: { totalRequests: -1 } },

        // ── Stage 5: Pagination ──────────────────────────────────────────
        { $skip: skip },
        { $limit: limit },
      ];

      // Execute the aggregation
      const endpointResults = await APIKeyUsage.aggregate<{
        endpoint: string;
        method: string;
        totalRequests: number;
        statusCodeBreakdown: { [key: string]: number };
        hours: Array<{ hour: Date; count: number; statusCode: number }>;
      }>(pipeline).exec();

      // ── Build overall totals ────────────────────────────────────────────
      let totalRequests = 0;
      const byStatusCode: { [statusCode: number]: number } = {};
      const byEndpoint: EndpointUsageSummary[] = [];
      const hourlyMap: Map<string, HourlyUsageData> = new Map();

      for (const result of endpointResults) {
        // Accumulate totals
        totalRequests += result.totalRequests;

        // Collect status code breakdowns
        for (const [code, count] of Object.entries(result.statusCodeBreakdown)) {
          const statusCode = parseInt(code, 10);
          byStatusCode[statusCode] = (byStatusCode[statusCode] ?? 0) + count;
        }

        // Add endpoint summary
        byEndpoint.push({
          endpoint: result.endpoint,
          method: result.method,
          totalRequests: result.totalRequests,
          statusCodeBreakdown: result.statusCodeBreakdown,
        });

        // Build hourly breakdown
        for (const hourData of result.hours) {
          const hourKey = hourData.hour.toISOString();
          const existing = hourlyMap.get(hourKey) ?? {
            hour: hourData.hour,
            requests: 0,
            statusCodeBreakdown: {},
          };
          existing.requests += hourData.count;
          existing.statusCodeBreakdown[hourData.statusCode] =
            (existing.statusCodeBreakdown[hourData.statusCode] ?? 0) +
            hourData.count;
          hourlyMap.set(hourKey, existing);
        }
      }

      // Convert hourly map to sorted array
      const hourlyBreakdown = Array.from(hourlyMap.values()).sort(
        (a, b) => a.hour.getTime() - b.hour.getTime()
      );

      return {
        apiKeyId,
        period: { from, to },
        totalRequests,
        byEndpoint,
        byStatusCode,
        hourlyBreakdown,
      };
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('[APIKeyUsage] Failed to retrieve usage:', error instanceof Error ? error.message : error);
      throw new AppError(
        'Failed to retrieve API key usage',
        500,
        'USAGE_QUERY_FAILED'
      );
    }
  }

  /**
   * Clean up old usage records (for maintenance/manual data cleanup).
   * Respects the TTL index configured in the model, but this can be called
   * manually if needed.
   * 
   * @param olderThanDays - Delete records older than this many days
   * @returns Number of documents deleted
   */
  async cleanupOldRecords(olderThanDays: number = 90): Promise<number> {
    try {
      const cutoffDate = new Date(
        Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      );

      const result = await APIKeyUsage.deleteMany({
        createdAt: { $lt: cutoffDate },
      }).exec();

      return result.deletedCount ?? 0;
    } catch (error: unknown) {
      console.error('[APIKeyUsage] Failed to clean up old records:', error instanceof Error ? error.message : error);
      throw new AppError(
        'Failed to clean up old usage records',
        500,
        'CLEANUP_FAILED'
      );
    }
  }
}

export const apiKeyUsageService = new APIKeyUsageService();
