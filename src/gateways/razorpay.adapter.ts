import { IGatewayAdapter, GatewayResponse, ParsedWebhookEvent } from './gateway.interface';
import { SimulatorService } from './simulator.service';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

export class RazorpayAdapter implements IGatewayAdapter {
  public name = 'Razorpay';

  public async initializePayment(
    transactionId: string,
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    merchantOrderId: string,
    metadata: any,
    traceId: string
  ): Promise<GatewayResponse> {
    const trigger = SimulatorService.parseTrigger(this.name, merchantOrderId, metadata);

    // Simulate delay
    if (trigger.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, trigger.latencyMs));
    }

    if (trigger.scenario === 'TIMEOUT') {
      throw new Error('Simulated gateway request timeout');
    }
    if (trigger.scenario === 'ERROR_500') {
      return {
        success: false,
        status: 'failed',
        error: 'Simulated 500 Internal Server Error',
        rawResponse: { error: 'Internal Error' },
      };
    }
    if (trigger.scenario === 'FAILURE') {
      return {
        success: false,
        status: 'failed',
        error: 'Simulated payment failed status',
        rawResponse: { error: 'Insufficient Funds' },
      };
    }

    const gatewayRef = `pay_${transactionId}`;

    // Trigger webhook asynchronously
    const actualDelay = trigger.scenario === 'DELAYED_WEBHOOK' ? 8000 : 500;
    const webhookStatus = trigger.scenario === ('AUTH_ONLY' as any) ? 'authorised' : 'captured';
    SimulatorService.triggerAsynchronousWebhook(
      this.name,
      `evt_${crypto.randomUUID()}`,
      transactionId,
      amountPaise,
      currency,
      webhookStatus as any,
      actualDelay
    );

    return {
      success: true,
      gatewayReferenceId: gatewayRef,
      status: 'authorised',
      rawResponse: {
        id: gatewayRef,
        amount: Number(amountPaise),
        currency,
        status: 'authorized',
        order_id: `order_${transactionId}`,
      },
    };
  }

  public async capturePayment(
    transactionId: string,
    gatewayRefId: string,
    amountPaise: bigint,
    traceId: string
  ): Promise<GatewayResponse> {
    return {
      success: true,
      gatewayReferenceId: gatewayRefId,
      status: 'captured',
      rawResponse: {
        id: gatewayRefId,
        status: 'captured',
      },
    };
  }

  public async refundPayment(
    transactionId: string,
    gatewayRefId: string,
    amountPaise: bigint,
    traceId: string
  ): Promise<GatewayResponse> {
    const refundId = `rfnd_${crypto.randomUUID()}`;
    return {
      success: true,
      gatewayReferenceId: refundId,
      status: 'refunded',
      rawResponse: {
        id: refundId,
        payment_id: gatewayRefId,
        status: 'processed',
      },
    };
  }

  public async voidPayment(transactionId: string, gatewayRefId: string, traceId: string): Promise<GatewayResponse> {
    return {
      success: true,
      gatewayReferenceId: gatewayRefId,
      status: 'voided',
      rawResponse: {
        id: gatewayRefId,
        status: 'voided',
      },
    };
  }

  public verifyWebhookSignature(headers: Record<string, string>, rawBody: string, secret: string): boolean {
    try {
      const razorpaySig = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'];
      if (!razorpaySig) {
        // Fallback for direct simulator posts
        const fallbackSig = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
        if (fallbackSig) {
          const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
          return this.safeCompare(fallbackSig, computed);
        }
        return false;
      }

      // Re-calculate signature
      const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      // Timestamp verification (Razorpay can pass timestamp in header or request body)
      const timestampHeader = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];
      if (timestampHeader) {
        const now = Math.floor(Date.now() / 1000);
        const timeDiff = Math.abs(now - parseInt(timestampHeader, 10));
        if (timeDiff > 300) {
          logger.error(`Razorpay webhook signature timestamp validation failed. Time delta: ${timeDiff}s`);
          return false;
        }
      }

      return this.safeCompare(razorpaySig, computed);
    } catch (err: any) {
      logger.error('Razorpay signature verification exception', { error: err.message });
      return false;
    }
  }

  public parseWebhookEvent(body: any): ParsedWebhookEvent {
    const eventType = body.event;
    const paymentEntity = body.payload.payment.entity;

    const transactionId = paymentEntity.notes?.transaction_id || paymentEntity.id.replace('pay_', '');

    let status: 'authorised' | 'captured' | 'failed' | 'refunded' = 'captured';
    if (eventType === 'payment.failed') {
      status = 'failed';
    } else if (eventType === 'refund.processed') {
      status = 'refunded';
    } else if (eventType === 'payment.authorized' || eventType === 'payment.authorised') {
      status = 'authorised';
    }

    return {
      eventId: body.id || `evt_${crypto.randomUUID()}`,
      transactionId,
      status,
      amountPaise: BigInt(paymentEntity.amount),
      gatewayReferenceId: paymentEntity.id,
      rawPayload: body,
    };
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }
}
