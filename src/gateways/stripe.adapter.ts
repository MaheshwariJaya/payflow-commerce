import { IGatewayAdapter, GatewayResponse, ParsedWebhookEvent } from './gateway.interface';
import { SimulatorService } from './simulator.service';
import { logger } from '../utils/logger';

import * as crypto from 'crypto';

export class StripeAdapter implements IGatewayAdapter {
  public name = 'Stripe';

  public async initializePayment(
    transactionId: string,
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    merchantOrderId: string,
    metadata: any,
    _traceId: string,
  ): Promise<GatewayResponse> {
    const trigger = SimulatorService.parseTrigger(this.name, merchantOrderId, metadata);

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
        error: 'Simulated transaction failure',
        rawResponse: { error: 'Card Declined' },
      };
    }

    const gatewayRef = `pi_${transactionId}`;

    const webhookDelay = trigger.scenario === 'OUT_OF_ORDER' ? 0 : 500;
    const actualDelay = trigger.scenario === 'DELAYED_WEBHOOK' ? 8000 : webhookDelay;
    const webhookStatus = trigger.scenario === ('AUTH_ONLY' as any) ? 'authorised' : 'captured';

    SimulatorService.triggerAsynchronousWebhook(
      this.name,
      `evt_${crypto.randomUUID()}`,
      transactionId,
      amountPaise,
      currency,
      webhookStatus as any,
      actualDelay,
    );

    return {
      success: true,
      gatewayReferenceId: gatewayRef,
      status: 'authorised',
      rawResponse: {
        id: gatewayRef,
        amount: Number(amountPaise) / 100,
        currency,
        status: 'requires_capture',
      },
    };
  }

  public async capturePayment(
    transactionId: string,
    gatewayRefId: string,
    _amountPaise: bigint,
    _traceId: string,
  ): Promise<GatewayResponse> {
    return {
      success: true,
      gatewayReferenceId: gatewayRefId,
      status: 'captured',
      rawResponse: {
        id: gatewayRefId,
        status: 'succeeded',
      },
    };
  }

  public async refundPayment(
    _transactionId: string,
    gatewayRefId: string,
    _amountPaise: bigint,
    _traceId: string,
  ): Promise<GatewayResponse> {
    const refundId = `re_${crypto.randomUUID()}`;
    return {
      success: true,
      gatewayReferenceId: refundId,
      status: 'refunded',
      rawResponse: {
        id: refundId,
        charge: gatewayRefId,
        status: 'succeeded',
      },
    };
  }

  public async voidPayment(transactionId: string, gatewayRefId: string, _traceId: string): Promise<GatewayResponse> {
    return {
      success: true,
      gatewayReferenceId: gatewayRefId,
      status: 'voided',
      rawResponse: {
        id: gatewayRefId,
        status: 'canceled',
      },
    };
  }

  public verifyWebhookSignature(headers: Record<string, string>, rawBody: string, secret: string): boolean {
    try {
      const stripeHeader = headers['stripe-signature'] || '';

      const parts = stripeHeader.split(',');
      const tPart = parts.find((p) => p.startsWith('t='));
      const v1Part = parts.find((p) => p.startsWith('v1='));

      if (!tPart || !v1Part) {
        const fallbackSig = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
        if (fallbackSig) {
          const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
          return this.safeCompare(fallbackSig, computed);
        }
        return false;
      }

      const timestamp = tPart.split('=')[1];
      const signature = v1Part.split('=')[1];

      const now = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(now - parseInt(timestamp, 10));
      if (timeDiff > 300) {
        logger.error(`Webhook signature timestamp validation failed. Time delta: ${timeDiff}s`);
        return false;
      }

      const payload = `${timestamp}.${rawBody}`;
      const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      return this.safeCompare(signature, computed);
    } catch (err: any) {
      logger.error('Stripe signature verification exception', { error: err.message });
      return false;
    }
  }

  public parseWebhookEvent(body: any): ParsedWebhookEvent {
    const eventType = body.type;
    const object = body.data.object;
    const transactionId = object.metadata.transaction_id || object.id.replace('pi_', '');

    let status: 'authorised' | 'captured' | 'failed' | 'refunded' = 'captured';
    if (eventType === 'payment_intent.payment_failed') {
      status = 'failed';
    } else if (eventType === 'charge.refunded') {
      status = 'refunded';
    } else if (eventType === 'payment_intent.amount_capturable_updated' || eventType === 'payment_intent.authorised') {
      status = 'authorised';
    }

    return {
      eventId: body.id,
      transactionId,
      status,
      amountPaise: BigInt(Math.round(object.amount * 100)),
      gatewayReferenceId: object.id,
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
