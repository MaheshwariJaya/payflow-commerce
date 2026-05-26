import { Request, Response, NextFunction } from 'express';
import { WebhookService } from '../services/webhook.service';
import { logger } from '../utils/logger';

export class WebhookController {
  /**
   * POST /api/v1/webhooks/stripe
   */
  public static async processStripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    await WebhookController.handleWebhook('Stripe', req, res, next);
  }

  /**
   * POST /api/v1/webhooks/razorpay
   */
  public static async processRazorpayWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    await WebhookController.handleWebhook('Razorpay', req, res, next);
  }

  /**
   * POST /api/v1/webhooks/payu
   */
  public static async processPayUWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    await WebhookController.handleWebhook('PayU', req, res, next);
  }

  /**
   * POST /api/v1/webhooks/upi
   */
  public static async processUPIWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    await WebhookController.handleWebhook('UPI', req, res, next);
  }

  /**
   * POST /api/v1/webhooks/replay/:event_id
   */
  public static async replayWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { event_id } = req.params;
      const traceId = res.getHeader('X-Trace-ID') as string || 'default-trace';

      const result = await WebhookService.replayWebhook(event_id, traceId);
      res.status(200).json(result);
    } catch (err: any) {
      logger.error('Failed to replay webhook', { error: err.message });
      next(err);
    }
  }

  /**
   * Base helper to receive, validate, and enqueue raw webhook events.
   */
  private static async handleWebhook(
    gateway: string,
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const headers = req.headers as Record<string, string>;
      const traceId = res.getHeader('X-Trace-ID') as string || 'default-trace';
      
      // Read raw body stored by custom express.json verify hook
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);

      const result = await WebhookService.receiveWebhook(gateway, headers, rawBody, traceId);

      if (result.success) {
        // Return 200 OK immediately to satisfy gateway requirements and prevent timeouts
        res.status(200).json({ status: 'success', message: result.message });
      } else {
        // Return 400 Bad Request if signature checks fail
        res.status(400).json({ status: 'error', error: 'SignatureMismatch', message: result.message });
      }
    } catch (err: any) {
      logger.error(`Webhook controller failed to process ${gateway} payload`, { error: err.message });
      next(err);
    }
  }
}
