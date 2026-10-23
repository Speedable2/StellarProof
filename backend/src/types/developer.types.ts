/**
 * Domain types for the Developer Job Management Dashboard.
 * Shared across all layers: models, services, controllers, and routes.
 */

import { VerificationStatus, IVerificationJob } from './verification.types';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /api/v1/developer/jobs
 */
export interface ListDeveloperJobsQuery {
  status?: VerificationStatus;
  appId?: string;
  jobType?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: 'createdAt' | 'status' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Query parameters for GET /api/v1/developer/usage/summary
 */
export interface GetUsageSummaryQuery {
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Single job item in the list response (excludes heavy fields)
 */
export interface DeveloperJobListItem {
  _id: string;
  ownerPublicKey: string;
  contentHash: string;
  status: VerificationStatus;
  createdAt: Date;
  updatedAt: Date;
  certificateId?: string;
  errorMessage?: string;
}

/**
 * Response for GET /api/v1/developer/jobs
 */
export interface ListDeveloperJobsResponse {
  success: true;
  data: DeveloperJobListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Response for GET /api/v1/developer/jobs/:id
 */
export interface GetDeveloperJobResponse {
  success: true;
  data: IVerificationJob;
}

/**
 * Status counts for usage summary
 */
export interface JobStatusSummary {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

/**
 * Per-app usage in summary
 */
export interface AppUsageSummary {
  appId: string;
  jobCount: number;
  statusCounts: JobStatusSummary;
}

/**
 * Response for GET /api/v1/developer/usage/summary
 */
export interface UsageSummaryResponse {
  success: true;
  data: {
    period: {
      from: Date;
      to: Date;
    };
    totalJobs: number;
    statusCounts: JobStatusSummary;
    successRate: number; // percentage 0-100, or 0 if no terminal jobs
    apps: AppUsageSummary[];
  };
}

// ---------------------------------------------------------------------------
// Error Response
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, string[] | string>;
}

// ---------------------------------------------------------------------------
// Service Layer Types
// ---------------------------------------------------------------------------

/**
 * Validated and parsed list jobs query with defaults applied
 */
export interface ValidatedListJobsQuery {
  status?: VerificationStatus;
  appId?: string;
  jobType?: string;
  createdFrom?: Date;
  createdTo?: Date;
  sortBy: 'createdAt' | 'status' | 'updatedAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

/**
 * Validated and parsed usage summary query
 */
export interface ValidatedUsageSummaryQuery {
  from: Date;
  to: Date;
}

/**
 * Result from listJobs service method
 */
export interface ListJobsResult {
  items: DeveloperJobListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Result from getUsageSummary service method
 */
export interface UsageSummaryResult {
  period: {
    from: Date;
    to: Date;
  };
  totalJobs: number;
  statusCounts: JobStatusSummary;
  successRate: number;
  apps: AppUsageSummary[];
}
