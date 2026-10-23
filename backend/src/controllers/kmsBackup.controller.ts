import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { kmsBackupService } from '../services/kmsBackup.service';

function ownerId(req: Request): string {
  if (!req.user) throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  return String(req.user._id);
}

export const createKmsBackup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const backup = await kmsBackupService.create(ownerId(req), ownerId(req));
    res.status(201).json({
      success: true,
      data: { id: backup.id, keyCount: backup.keys.length, createdAt: backup.createdAt },
    });
  } catch (error) {
    next(error);
  }
};

export const listKmsBackups = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const backups = await kmsBackupService.list(ownerId(req));
    res.status(200).json({
      success: true,
      data: backups.map((backup) => ({
        id: backup.id,
        keyCount: backup.keys.length,
        createdAt: backup.createdAt,
        keys: backup.keys.map(({ keyId, keyVersion, isActive }) => ({ keyId, keyVersion, isActive })),
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const restoreKmsBackup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await kmsBackupService.restore(ownerId(req), req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
