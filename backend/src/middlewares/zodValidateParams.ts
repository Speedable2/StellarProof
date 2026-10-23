import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../errors/AppError';

/**
 * Validates `req.params` against a zod schema
 */
export const zodParams =
  (schema: ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`);
      next(new AppError(`Invalid request parameters: ${details.join('; ')}`, StatusCodes.BAD_REQUEST, 'VALIDATION_ERROR'));
      return;
    }
    req.params = parsed.data;
    next();
  };
