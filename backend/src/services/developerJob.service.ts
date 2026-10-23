/**
 * Developer Job Management Service
 *
 * Provides business logic for:
 * - Listing jobs across all of a developer's apps
 * - Retrieving single job details
 * - Computing usage summaries
 *
 * The developer identity is the authenticated user's stellarPublicKey.
 * All queries are scoped to jobs owned by that developer.
 */

import { StatusCodes } from 'http-status-codes';
import { isValidObjectId } from 'mongoose';

import { VerificationJobModel } from '../models/verificationJob.model';
import { VerificationStatus } from '../types/verification.types';
import {
  ValidatedListJobsQuery,
  ValidatedUsageSummaryQuery,
  ListJobsResult,
  UsageSummaryResult,
  DeveloperJobListItem,
  JobStatusSummary,
  AppUsageSummary,
} from '../types/developer.types';
import { AppError } from '../errors/AppError';

// Constants
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_FIELD = 'createdAt';
const DEFAULT_SORT_ORDER = 'desc';
const MAX_DATE_RANGE_DAYS = 365;
const DEFAULT_DATE_RANGE_DAYS = 30;
const ALLOWED_SORT_FIELDS = ['createdAt', 'status', 'updatedAt'] as const;

/**
 * Maps VerificationStatus to normalized usage summary status
 */
function normalizeStatus(status: VerificationStatus): string {
  switch (status) {
    case VerificationStatus.PENDING:
    case VerificationStatus.PROCESSING:
      return 'running';
    case VerificationStatus.TEE_VERIFYING:
    case VerificationStatus.MINTING:
      return 'running';
    case VerificationStatus.COMPLETED:
      return 'succeeded';
    case VerificationStatus.FAILED:
      return 'failed';
    default:
      return 'queued';
  }
}

/**
 * Service singleton
 */
class DeveloperJobService {
  /**
   * List jobs for a developer across all apps
   *
   * @param developerId - The developer's user ID (MongoDB ObjectId)
   * @param developerStellarKey - The developer's Stellar public key
   * @param query - Validated and parsed query parameters
   * @returns List of jobs with pagination metadata
   * @throws AppError if parameters are invalid
   */
  async listJobs(
    developerId: string,
    developerstellarKey: string,
    query: ValidatedListJobsQuery
  ): Promise<ListJobsResult> {
    // Validate pagination parameters
    if (query.page < 1) {
      throw new AppError(
        'Page must be >= 1',
        StatusCodes.BAD_REQUEST,
        'INVALID_PAGINATION'
      );
    }
    if (query.limit < 1 || query.limit > MAX_PAGE_SIZE) {
      throw new AppError(
        `Limit must be between 1 and ${MAX_PAGE_SIZE}`,
        StatusCodes.BAD_REQUEST,
        'INVALID_PAGINATION'
      );
    }

    // Build query filter
    const filter: Record<string, any> = {
      ownerPublicKey: developerstellarKey,
    };

    if (query.status) {
      filter.status = query.status;
    }

    if (query.createdFrom || query.createdTo) {
      filter.createdAt = {};
      if (query.createdFrom) {
        filter.createdAt.$gte = query.createdFrom;
      }
      if (query.createdTo) {
        filter.createdAt.$lte = query.createdTo;
      }
    }

    // Calculate skip
    const skip = (query.page - 1) * query.limit;

    // Build sort object
    const sortField = ALLOWED_SORT_FIELDS.includes(query.sortBy)
      ? query.sortBy
      : DEFAULT_SORT_FIELD;
    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortOrder };

    // Execute query
    const [jobs, total] = await Promise.all([
      VerificationJobModel.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(query.limit)
        .select([
          '_id',
          'ownerPublicKey',
          'contentHash',
          'status',
          'createdAt',
          'updatedAt',
          'certificateId',
          'errorMessage',
        ])
        .lean<any[]>()
        .exec(),
      VerificationJobModel.countDocuments(filter),
    ]);

    const items = jobs.map(
      (job): DeveloperJobListItem => ({
        _id: job._id.toString(),
        ownerPublicKey: job.ownerPublicKey,
        contentHash: job.contentHash,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        certificateId: job.certificateId,
        errorMessage: job.errorMessage,
      })
    );

    const totalPages = Math.ceil(total / query.limit);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      totalPages,
    };
  }

  /**
   * Retrieve a single job by ID, verifying ownership
   *
   * @param developerId - The developer's user ID (MongoDB ObjectId)
   * @param developerstellarKey - The developer's Stellar public key
   * @param jobId - The job ID to retrieve
   * @returns Full job document, or undefined if not found/not owned
   * @throws AppError if jobId is malformed
   */
  async getJobById(
    developerId: string,
    developerstellarKey: string,
    jobId: string
  ): Promise<any> {
    // Validate ObjectId format
    if (!isValidObjectId(jobId)) {
      throw new AppError(
        'Invalid job ID format',
        StatusCodes.BAD_REQUEST,
        'INVALID_JOB_ID'
      );
    }

    const job = await VerificationJobModel.findOne({
      _id: jobId,
      ownerPublicKey: developerstellarKey,
    })
      .lean()
      .exec();

    if (!job) {
      throw new AppError(
        'Job not found',
        StatusCodes.NOT_FOUND,
        'JOB_NOT_FOUND'
      );
    }

    return job;
  }

  /**
   * Compute usage summary for a developer
   *
   * Aggregates job counts by status and per-app using the database
   * aggregation pipeline for efficiency.
   *
   * @param developerId - The developer's user ID (MongoDB ObjectId)
   * @param developerstellarKey - The developer's Stellar public key
   * @param query - Validated date range query
   * @returns Usage summary with status counts and per-app breakdown
   * @throws AppError if date range is invalid
   */
  async getUsageSummary(
    developerId: string,
    developerstellarKey: string,
    query: ValidatedUsageSummaryQuery
  ): Promise<UsageSummaryResult> {
    const { from, to } = query;

    // Validate date range
    if (from > to) {
      throw new AppError(
        'from date must be before to date',
        StatusCodes.BAD_REQUEST,
        'INVALID_DATE_RANGE'
      );
    }

    const rangeMs = to.getTime() - from.getTime();
    const maxRangeMs = MAX_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (rangeMs > maxRangeMs) {
      throw new AppError(
        `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
        StatusCodes.BAD_REQUEST,
        'DATE_RANGE_TOO_LARGE'
      );
    }

    // Aggregate job data
    const pipeline = [
      {
        $match: {
          ownerPublicKey: developerstellarKey,
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          totalJobs: { $sum: 1 },
          statuses: {
            $push: '$status',
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalJobs: 1,
          statuses: 1,
        },
      },
    ];

    const result = await VerificationJobModel.aggregate(pipeline).exec();
    const aggregated = result[0] || { totalJobs: 0, statuses: [] };

    // Compute status counts
    const statusCounts: JobStatusSummary = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };

    let succeededCount = 0;
    let failedCount = 0;

    for (const status of aggregated.statuses) {
      const normalized = normalizeStatus(status);
      statusCounts[normalized as keyof JobStatusSummary]++;
      if (normalized === 'succeeded') succeededCount++;
      if (normalized === 'failed') failedCount++;
    }

    // Compute success rate
    const terminalCount = succeededCount + failedCount;
    const successRate =
      terminalCount > 0
        ? Math.round((succeededCount / terminalCount) * 100 * 100) / 100 // 2 decimal places
        : 0;

    // Get per-app breakdown
    const appsPipeline = [
      {
        $match: {
          ownerPublicKey: developerstellarKey,
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$assetId', 'unknown'] },
          jobCount: { $sum: 1 },
          statuses: { $push: '$status' },
        },
      },
      {
        $sort: { jobCount: -1 },
      },
      {
        $limit: 100, // reasonable limit for per-app breakdown
      },
    ];

    const appsResult = await VerificationJobModel.aggregate(
      appsPipeline
    ).exec();
    const apps: AppUsageSummary[] = appsResult.map((app: any) => {
      const appStatusCounts: JobStatusSummary = {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
      };

      for (const status of app.statuses) {
        const normalized = normalizeStatus(status);
        appStatusCounts[normalized as keyof JobStatusSummary]++;
      }

      return {
        appId: app._id.toString(),
        jobCount: app.jobCount,
        statusCounts: appStatusCounts,
      };
    });

    return {
      period: { from, to },
      totalJobs: aggregated.totalJobs,
      statusCounts,
      successRate,
      apps,
    };
  }
}

export const developerJobService = new DeveloperJobService();
