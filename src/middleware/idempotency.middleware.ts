import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { LockUtil } from '../utils/lock.util';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

/**
 * Middleware to enforce and handle idempotency for state-mutating requests.
 */
export function idempotency(options: { ttlHours: number } = { ttlHours: 24 }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string;
    
    // Non-mutating methods don't strictly require idempotency, but we check if key is provided
    if (req.method === 'GET' || req.method === 'DELETE') {
      return next();
    }

    if (!key) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required Idempotency-Key header on mutating request.',
      });
      return;
    }

    // Hash the body to detect key reuse with modified payloads
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const lockKey = `idempotency:${key}`;
    let lockToken: string | null = null;

    try {
      // 1. Try to acquire the Redis distributed lock to handle concurrent submits
      let attempts = 0;
      while (attempts < 6) {
        lockToken = await LockUtil.acquireRedisLock(lockKey, 5000);
        if (lockToken) break;
        
        // Wait and retry (500ms backoff)
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (!lockToken) {
        logger.warn('Lock acquisition timeout for idempotency key', { key });
        res.status(409).json({
          error: 'Conflict',
          message: 'Another request with the same idempotency key is currently processing. Please try again.',
        });
        return;
      }

      // 2. Query idempotency record from PostgreSQL
      const record = await prisma.idempotencyKey.findUnique({
        where: { key },
      });

      if (record) {
        // Double Check Hash to prevent malicious reuse
        if (record.request_hash !== requestHash) {
          logger.error('Idempotency key reuse detected with different payload hash', { key });
          await LockUtil.releaseRedisLock(lockKey, lockToken);
          res.status(400).json({
            error: 'Bad Request',
            message: 'Idempotency key already used for a different request payload.',
          });
          return;
        }

        if (record.status === 'PENDING') {
          logger.warn('Duplicate request received while initial transaction is still pending', { key });
          await LockUtil.releaseRedisLock(lockKey, lockToken);
          res.status(409).json({
            error: 'Conflict',
            message: 'A transaction with this idempotency key is already in progress.',
          });
          return;
        }

        if (record.status === 'COMPLETED') {
          logger.info('Returning cached response for idempotency key', { key });
          await LockUtil.releaseRedisLock(lockKey, lockToken);
          
          res.status(record.response_status || 200).json(record.response_body);
          return;
        }
      }

      // 3. Register PENDING transaction in DB
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + options.ttlHours);

      await prisma.idempotencyKey.create({
        data: {
          key,
          request_hash: requestHash,
          status: 'PENDING',
          expires_at: expiresAt,
        },
      });

      // 4. Release lock so long running gateway operations don't block concurrent status checks
      await LockUtil.releaseRedisLock(lockKey, lockToken);
      lockToken = null;

      // 5. Intercept response to store completion payload
      const originalSend = res.send;
      
      res.send = function (body: any): Response {
        // Restore original send method immediately to prevent recursion
        res.send = originalSend;

        // Process response storage asynchronously
        const responseStatus = res.statusCode;
        let responseBody: any;
        try {
          responseBody = JSON.parse(body);
        } catch {
          responseBody = body;
        }

        // Run update in background
        (async () => {
          let updateLock: string | null = null;
          try {
            updateLock = await LockUtil.acquireRedisLock(lockKey, 5000);
            if (updateLock) {
              await prisma.idempotencyKey.update({
                where: { key },
                data: {
                  status: 'COMPLETED',
                  response_status: responseStatus,
                  response_body: responseBody,
                },
              });
            }
          } catch (err: any) {
            logger.error('Failed to update idempotency response cache', { key, error: err.message });
          } finally {
            if (updateLock) {
              await LockUtil.releaseRedisLock(lockKey, updateLock);
            }
          }
        })();

        return originalSend.call(this, body);
      };

      next();
    } catch (error: any) {
      logger.error('Idempotency middleware exception', { error: error.message, key });
      if (lockToken) {
        await LockUtil.releaseRedisLock(lockKey, lockToken);
      }
      next(error);
    }
  };
}
