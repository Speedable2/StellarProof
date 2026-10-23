import { Router } from 'express';
import { rotateKey, getAllKeys, getActiveKey, revokeKey, getKeySummary } from '../controllers/kms.controller';

const router = Router();

/**
 * GET /api/v1/kms/keys/:userId/summary
 * Get KMS key summary report for a user (status counts & asset counts per version)
 */
router.get('/keys/:userId/summary', getKeySummary);

/**
 * POST /api/v1/kms/rotate/:userId
 * Rotate KMS key for a user
 */
router.post('/rotate/:userId', rotateKey);

/**
 * GET /api/v1/kms/keys/:userId
 * Get all KMS keys for a user
 */
router.get('/keys/:userId', getAllKeys);

/**
 * GET /api/v1/kms/keys/:userId/active
 * Get active KMS key for a user
 */
router.get('/keys/:userId/active', getActiveKey);

/**
 * DELETE /api/v1/kms/keys/:keyId
 * Revoke a KMS key (set isActive to false)
 */
router.delete('/keys/:keyId', revokeKey);

export default router;