import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { LockUtil } from '../utils/lock.util';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export function idempotency(options: { ttlHours: number } = { ttlHours: 24 }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers['idempotency-key'] as string;

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

    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const lockKey = `idempotency:${key}`;
    let lockToken: string | null = null;

    try {
      let attempts = 0;
      while (attempts < 6) {
        lockToken = await LockUtil.acquireRedisLock(lockKey, 5000);
        if (lockToken) break;

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

      const record = await prisma.idempotencyKey.findUnique({
        where: { key },
      });

      if (record) {
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

      await LockUtil.releaseRedisLock(lockKey, lockToken);
      lockToken = null;

      const originalSend = res.send;

      res.send = function (body: any): Response {
        res.send = originalSend;

        const responseStatus = res.statusCode;
        let responseBody: any;
        try {
          responseBody = JSON.parse(body);
        } catch {
          responseBody = body;
        }

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
            logger.error('Failed to update idempotency response cache', {
              key,
              error: err.message,
            });
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
      logger.error('Idempotency middleware exception', {
        error: error.message,
        key,
      });
      if (lockToken) {
        await LockUtil.releaseRedisLock(lockKey, lockToken);
      }
      next(error);
    }
  };
}
