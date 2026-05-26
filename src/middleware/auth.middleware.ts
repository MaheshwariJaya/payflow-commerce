import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforpayflow';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'admin-key-12345';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

/**
 * Middleware to authenticate requests using JWT.
 */
export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Missing or invalid token format. Expected Bearer <token>' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err: any) {
    logger.warn('JWT Verification failed', { error: err.message });
    res.status(403).json({ error: 'Forbidden', message: 'Token is invalid or expired.' });
  }
}

/**
 * Middleware to authenticate administrative/internal API calls using X-API-Key.
 */
export function authenticateApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'.toLowerCase()];

  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    logger.warn('Unauthorized API Key attempt', {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing administrative API Key (X-API-Key)' });
    return;
  }

  next();
}

/**
 * Dual authentication middleware supporting either X-API-Key or Bearer JWT token.
 */
export function authenticateJWTOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'.toLowerCase()];

  if (apiKey) {
    return authenticateApiKey(req, res, next);
  }

  return authenticateJWT(req, res, next);
}
