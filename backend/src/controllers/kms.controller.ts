import { Request, Response, NextFunction } from 'express';
import { kmsService } from '../services/kms.service';
import { AppError } from '../errors/AppError';

export const getKeySummary = async (
  req: Request,
  res: Response,
  next?: NextFunction
): Promise<void> => {
  try {
    const { userId } = req.params;
    const summary = await kmsService.getKeySummary(userId);
    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    if (next) {
      return next(error);
    }
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    res.status(statusCode).json({
      success: false,
      error: (error as Error).message,
      ...(error instanceof AppError && error.code ? { code: error.code } : {}),
    });
  }
};

export const rotateKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const result = await kmsService.rotateKey(userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

export const getAllKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const keys = await kmsService.getAllKeys(userId);
    res.status(200).json({ success: true, data: keys });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

export const getActiveKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const key = await kmsService.getActiveKey(userId);
    res.status(200).json({ success: true, data: key });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};

export const revokeKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const { keyId } = req.params;
    const actorId = req.user ? String(req.user._id) : undefined;
    const key = await kmsService.revokeKey(keyId, actorId);
    res.status(200).json({ success: true, data: key });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
};