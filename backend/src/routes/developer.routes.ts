/**
 * Developer Routes.
 *
 * Endpoints mounted under `/api/v1/developer`:
 *   POST   /keys                                    – generate a new API key
 *   GET    /api-keys/:keyId/usage                   – API key usage metrics
 *   GET    /jobs                                    – list jobs (job dashboard)
 *   GET    /jobs/:id                                – single job details
 *   GET    /usage/summary                           – developer usage summary
 *   POST   /webhooks                                – register a webhook
 *   GET    /webhooks                                – list registered webhooks
 *   PATCH  /webhooks/:id                            – update a webhook
 *   DELETE /webhooks/:id                            – delete a webhook
 *   POST   /kms/backups                             – create a KMS backup
 *   GET    /kms/backups                             – list KMS backups
 *   POST   /kms/backups/:id/restore                 – restore a KMS backup
 *   POST   /apps                                    – create a developer app
 *   GET    /apps                                    – list developer apps
 *   GET    /apps/:appId                             – app details
 *   POST   /apps/:appId/webhooks                    – register app webhook
 *   POST   /webhooks/:id/deliveries/:deliveryId/replay – replay failed delivery
 *   POST   /webhooks/:id/rotate-secret              – rotate webhook HMAC secret
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import {
  generateApiKey,
  developerController,
  getApiKeyUsage,
  replayWebhookDelivery,
  rotateWebhookSecret,
  createDeveloperApp,
  listDeveloperApps,
  getAppDetailsController,
  registerAppWebhook,
  createWebhookRegistration,
  listWebhookRegistrations,
  listWebhookDeliveries,
  updateWebhookRegistration,
  deleteWebhookRegistration,
} from '../controllers/developer.controller';
import { createKmsBackup, listKmsBackups, restoreKmsBackup } from '../controllers/kmsBackup.controller';
import { protect } from '../middlewares/auth.middleware';
import { verifyJWT } from '../middlewares/jwt.middleware';
import { verifyApiKey } from '../middlewares/apiKey.middleware';
import { zodBody } from '../middlewares/zodValidate';
import { zodParams } from '../middlewares/zodValidateParams';
import { createAppSchema, appIdSchema, registerWebhookSchema } from '../middlewares/app.validation';
import { VerificationWebhookEvent } from '../types/verification.types';

const router = Router();

const webhookEvents = Object.values(VerificationWebhookEvent) as [
  VerificationWebhookEvent,
  ...VerificationWebhookEvent[],
];
const idParamsSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'id must be a valid MongoDB ObjectId'),
});
const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(webhookEvents)).min(1),
}).strict();
const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.enum(webhookEvents)).min(1).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one update field is required');
const deliveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).default(0),
});

/**
 * Validation schema for list jobs query parameters.
 */
const listJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
  status: z.enum(['pending', 'processing', 'tee_verifying', 'minting', 'completed', 'failed']).optional(),
  appId: z.string().optional(),
  jobType: z.string().optional(),
  createdFrom: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date format').optional(),
  createdTo: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date format').optional(),
  sortBy: z.enum(['createdAt', 'status', 'updatedAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

/**
 * Validation schema for usage summary query parameters.
 */
const usageSummaryQuerySchema = z.object({
  from: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date format').optional(),
  to: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date format').optional(),
});

/**
 * Validate list jobs query parameters.
 */
function validateListJobsQuery(req: Request, res: Response, next: NextFunction): void {
  const result = listJobsQuerySchema.safeParse(req.query);
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: 'Invalid query parameters',
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  Object.assign(req.query, result.data);
  next();
}

/**
 * Validate usage summary query parameters.
 */
function validateUsageSummaryQuery(req: Request, res: Response, next: NextFunction): void {
  const result = usageSummaryQuerySchema.safeParse(req.query);
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: 'Invalid query parameters',
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  Object.assign(req.query, result.data);
  next();
}

/**
 * Validate job ID path parameter.
 */
function validateJobIdParam(req: Request, res: Response, next: NextFunction): void {
  const result = z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid job ID format'),
  }).safeParse({ id: req.params.id });
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: 'Invalid job ID format',
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  next();
}

/**
 * Validate delivery pagination query parameters.
 */
function validateDeliveryQuery(req: Request, res: Response, next: NextFunction): void {
  const parsed = deliveryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: 'Invalid pagination parameters',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  res.locals.deliveryPagination = parsed.data;
  next();
}

/**
 * @swagger
 * /api/v1/developer/keys:
 *   post:
 *     summary: Generate API key (legacy endpoint)
 *     tags: [Developer]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       201: { description: API key generated }
 *       400: { description: Invalid parameters }
 */
router.post('/keys', generateApiKey);
router.post('/webhooks', protect, createWebhookRegistration);
router.get('/webhooks', protect, listWebhookRegistrations);
router.get(
  '/webhooks/:id/deliveries',
  protect,
  zodParams(idParamsSchema),
  validateDeliveryQuery,
  listWebhookDeliveries
);
router.patch('/webhooks/:id', protect, updateWebhookRegistration);
router.delete('/webhooks/:id', protect, deleteWebhookRegistration);
router.post('/kms/backups', protect, createKmsBackup);
router.get('/kms/backups', protect, listKmsBackups);
router.post('/kms/backups/:id/restore', protect, restoreKmsBackup);

// App management
router.post('/apps', zodBody(createAppSchema), createDeveloperApp);
router.get('/apps', listDeveloperApps);
router.get('/apps/:appId', zodParams(appIdSchema), getAppDetailsController);

// Webhook registration
router.post(
  '/apps/:appId/webhooks',
  zodParams(appIdSchema),
  zodBody(registerWebhookSchema),
  registerAppWebhook
);

/**
 * GET /api/v1/developer/api-keys/:keyId/usage
 * Retrieve aggregated API usage metrics for a specific API key.
 *
 * Authentication: Required (JWT or API Key)
 * Authorization: Caller must own the API key
 *
 * Query parameters:
 *   - from: ISO date string (defaults to 7 days ago)
 *   - to: ISO date string (defaults to now)
 *   - endpoint: optional filter by endpoint pattern
 *   - granularity: 'hour' or 'day' (defaults to 'hour')
 *   - limit: max results (defaults to 1000, max 10000)
 *   - skip: pagination offset (defaults to 0)
 */
router.get('/api-keys/:keyId/usage', verifyJWT, getApiKeyUsage);

/**
 * @swagger
 * /api/v1/developer/jobs:
 *   get:
 *     summary: List jobs across all developer apps
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 20 } }
 *       - { in: query, name: status, schema: { type: string, enum: ['pending', 'processing', 'tee_verifying', 'minting', 'completed', 'failed'] } }
 *       - { in: query, name: appId, schema: { type: string } }
 *       - { in: query, name: jobType, schema: { type: string } }
 *       - { in: query, name: createdFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: createdTo, schema: { type: string, format: date-time } }
 *       - { in: query, name: sortBy, schema: { type: string, enum: ['createdAt', 'status', 'updatedAt'], default: 'createdAt' } }
 *       - { in: query, name: sortOrder, schema: { type: string, enum: ['asc', 'desc'], default: 'desc' } }
 *     responses:
 *       200: { description: List of jobs with pagination }
 *       400: { description: Invalid query parameters }
 *       401: { description: Authentication required }
 */
router.get(
  '/jobs',
  protect,
  validateListJobsQuery,
  developerController.listJobs.bind(developerController)
);

/**
 * @swagger
 * /api/v1/developer/jobs/{id}:
 *   get:
 *     summary: Get a single job by ID
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, pattern: '^[a-f0-9]{24}$' } }
 *     responses:
 *       200: { description: Job details }
 *       400: { description: Invalid job ID format }
 *       401: { description: Authentication required }
 *       404: { description: Job not found or not owned by developer }
 */
router.get(
  '/jobs/:id',
  protect,
  validateJobIdParam,
  developerController.getJobById.bind(developerController)
);

/**
 * @swagger
 * /api/v1/developer/usage/summary:
 *   get:
 *     summary: Get usage summary for developer
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Usage summary with status counts and per-app breakdown }
 *       400: { description: Invalid date parameters }
 *       401: { description: Authentication required }
 */
router.get(
  '/usage/summary',
  protect,
  validateUsageSummaryQuery,
  developerController.getUsageSummary.bind(developerController)
);

// ---------------------------------------------------------------------------
// Zod schema – path parameters for the delivery replay endpoint.
// ---------------------------------------------------------------------------
export const replayDeliveryParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'webhook id is required')
    .max(128, 'webhook id must be at most 128 characters'),
  deliveryId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'deliveryId must be a valid MongoDB ObjectId'),
});

export const rotateWebhookSecretBodySchema = z.object({
  gracePeriodSeconds: z.number().int().min(0).max(604800).optional(),
});

// ---------------------------------------------------------------------------
// Path parameter validation middleware
// ---------------------------------------------------------------------------
function validateReplayDeliveryParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = replayDeliveryParamsSchema.safeParse(req.params);
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: 'Invalid path parameters',
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  next();
}

/**
 * POST /api/v1/developer/webhooks/:id/deliveries/:deliveryId/replay
 *
 * Response 200:
 * {
 *   "success": true,
 *   "message": "Webhook delivery replayed successfully.",
 *   "data": {
 *     "delivery": { "id": "...", "status": "delivered", "attempts": 2, ... },
 *     "delivered": true,
 *     "responseStatus": 200
 *   }
 * }
 */
router.post(
  '/webhooks/:id/deliveries/:deliveryId/replay',
  verifyApiKey,
  validateReplayDeliveryParams,
  replayWebhookDelivery
);

router.post(
  '/webhooks/:id/rotate-secret',
  verifyApiKey,
  (req: Request, res: Response, next: NextFunction): void => {
    const params = replayDeliveryParamsSchema.shape.id.safeParse(req.params.id);
    const body = rotateWebhookSecretBodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(StatusCodes.BAD_REQUEST).json({ success: false, error: 'Invalid rotate-secret request' });
      return;
    }
    req.params.id = params.data;
    req.body = body.data;
    next();
  },
  rotateWebhookSecret
);

export default router;
