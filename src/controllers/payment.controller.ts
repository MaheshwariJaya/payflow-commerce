import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from '../services/payment.service';
import { serializeBigInt } from '../utils/serialization';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class PaymentController {
  /**
   * POST /api/v1/payments
   */
  public static async createPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { amount_paise, currency, payment_method, customer_id, merchant_order_id, metadata } = req.body;
      const idempotencyKey = req.headers['idempotency-key'] as string;
      const traceId = (res.getHeader('X-Trace-ID') as string) || 'default-trace';

      if (!amount_paise || !currency || !payment_method || !customer_id || !merchant_order_id) {
        res.status(400).json({
          error: 'Bad Request',
          message:
            'Missing required request body parameters: amount_paise, currency, payment_method, customer_id, merchant_order_id',
        });
        return;
      }

      // Convert amount_paise to BigInt
      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount_paise);
        if (parsedAmount <= BigInt(0)) {
          throw new Error('Amount must be greater than zero');
        }
      } catch (err: any) {
        res.status(400).json({ error: 'Bad Request', message: `Invalid amount_paise: ${err.message}` });
        return;
      }

      const transaction = await PaymentService.createPayment(
        parsedAmount,
        currency,
        payment_method,
        customer_id,
        merchant_order_id,
        idempotencyKey,
        metadata,
        traceId
      );

      res.status(201).json(serializeBigInt(transaction));
    } catch (err: any) {
      logger.error('Payment controller createPayment failure', { error: err.message });
      next(err);
    }
  }

  /**
   * GET /api/v1/payments/:id
   */
  public static async getPaymentDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      const transaction = await prisma.transaction.findUnique({
        where: { id },
        include: { refunds: true },
      });

      if (!transaction) {
        res.status(404).json({ error: 'Not Found', message: `Transaction with ID ${id} not found.` });
        return;
      }

      res.status(200).json(serializeBigInt(transaction));
    } catch (err: any) {
      next(err);
    }
  }

  /**
   * POST /api/v1/payments/:id/capture
   */
  public static async capturePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { amount_paise } = req.body;
      const traceId = (res.getHeader('X-Trace-ID') as string) || 'default-trace';

      if (!amount_paise) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing required parameter: amount_paise' });
        return;
      }

      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount_paise);
      } catch (err: any) {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid amount_paise formatting' });
        return;
      }

      const transaction = await PaymentService.capturePayment(id, parsedAmount, traceId);
      res.status(200).json(serializeBigInt(transaction));
    } catch (err: any) {
      logger.error('Payment controller capturePayment failure', { error: err.message });
      next(err);
    }
  }

  /**
   * POST /api/v1/payments/:id/refund
   */
  public static async refundPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { amount_paise, reason } = req.body;
      const traceId = (res.getHeader('X-Trace-ID') as string) || 'default-trace';

      if (!amount_paise || !reason) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing required parameters: amount_paise, reason' });
        return;
      }

      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount_paise);
      } catch (err: any) {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid amount_paise formatting' });
        return;
      }

      const refund = await PaymentService.refundPayment(id, parsedAmount, reason, traceId);
      res.status(200).json(serializeBigInt(refund));
    } catch (err: any) {
      logger.error('Payment controller refundPayment failure', { error: err.message });
      next(err);
    }
  }

  /**
   * POST /api/v1/payments/:id/void
   */
  public static async voidPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const traceId = (res.getHeader('X-Trace-ID') as string) || 'default-trace';

      const transaction = await PaymentService.voidPayment(id, traceId);
      res.status(200).json(serializeBigInt(transaction));
    } catch (err: any) {
      logger.error('Payment controller voidPayment failure', { error: err.message });
      next(err);
    }
  }

  /**
   * GET /api/v1/payments/:id/timeline
   */
  public static async getTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      const logs = await prisma.transactionStateLog.findMany({
        where: { transaction_id: id },
        orderBy: { created_at: 'asc' },
      });

      res.status(200).json(serializeBigInt(logs));
    } catch (err: any) {
      next(err);
    }
  }

  /**
   * GET /api/v1/payments (Admin utility)
   */
  public static async listPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const payments = await prisma.transaction.findMany({
        take: 20,
        orderBy: { created_at: 'desc' },
      });
      res.status(200).json(serializeBigInt(payments));
    } catch (err: any) {
      next(err);
    }
  }
}
