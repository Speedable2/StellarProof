import { Request, Response, NextFunction } from 'express';
import { apiKeyUsageService } from '../services/apiKeyUsage.service';
import { userService } from '../services/user.service';

/**
 * API Key Metering Middleware
 * 
 * Records API request counts, endpoints, methods, and status codes per API key,
 * aggregated hourly into the apiKeyUsage MongoDB collection.
 * 
 * Behavior:
 * - Hooks into res.on('finish') to capture the final response status code
 * - Only meters requests authenticated with an API key (via verifyApiKey middleware)
 * - Normalizes the route pattern (e.g., /api/v1/certificates/123 → /api/v1/certificates/:id)
 * - Executes fire-and-forget: failures logged but never alter or delay the response
 * - Secrets and request bodies never stored
 */
export const meteringMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Only meter API key authenticated requests
  // If no user is attached to the request, skip metering
  if (!req.user || !req.apiKeyHash) {
    return next();
  }

  // Capture the route pattern and method at request time
  const method = req.method.toUpperCase();
  let endpoint = req.baseUrl + (req.route?.path ?? req.path);

  const apiKeyHash = req.apiKeyHash;
  const user = req.user;

  // On response finish, record the usage asynchronously (fire-and-forget)
  res.on('finish', () => {
    recordUsageAsync({
      user,
      apiKeyHash,
      endpoint,
      method,
      statusCode: res.statusCode,
    });
  });

  next();
};

/**
 * Helper to record usage asynchronously without blocking the response.
 * 
 * @param options - Request context including user, API key hash, and response metadata
 */
function recordUsageAsync(options: {
  user: any;
  apiKeyHash: string;
  endpoint: string;
  method: string;
  statusCode: number;
}): void {
  try {
    const { user, apiKeyHash, endpoint, method, statusCode } = options;

    // Verify required fields
    if (!user || !user._id || !apiKeyHash) {
      return;
    }

    // Record the usage asynchronously (fire-and-forget)
    // Use setImmediate to ensure this runs after the response is sent
    setImmediate(async () => {
      try {
        await apiKeyUsageService.recordUsage({
          apiKeyId: apiKeyHash,
          endpoint,
          method,
          statusCode,
          timestamp: new Date(),
        });
      } catch (error: unknown) {
        // Log the error but never throw—metering must never affect the API response
        console.error(
          '[Metering] Error recording usage:',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  } catch (error: unknown) {
    // Catch any synchronous errors in setup
    console.error(
      '[Metering] Error in recordUsageAsync:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Extended Express Request type to include apiKeyHash (optional).
 * This should be added to the Request type definition in your application types.
 */
declare global {
  namespace Express {
    interface Request {
      apiKeyHash?: string;
    }
  }
}
