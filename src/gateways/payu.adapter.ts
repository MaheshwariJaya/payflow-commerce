import { IGatewayAdapter, GatewayResponse, ParsedWebhookEvent } from './gateway.interface';
import { SimulatorService } from './simulator.service';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

export class PayUAdapter implements IGatewayAdapter {
  public name = 'PayU';

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
        rawResponse: { error: 'Invalid CVV' },
      };
    }

    const gatewayRef = `payu_${transactionId}`;

    // Trigger webhook asynchronously
    const actualDelay = trigger.scenario === 'DELAYED_WEBHOOK' ? 8000 : 500;
    SimulatorService.triggerAsynchronousWebhook(
      this.name,
      `evt_${crypto.randomUUID()}`,
      transactionId,
      amountPaise,
      currency,
      'captured',
      actualDelay
    );

    return {
      success: true,
      gatewayReferenceId: gatewayRef,
      status: 'authorised',
      rawResponse: {
        mihpayid: gatewayRef,
        amount: Number(amountPaise) / 100,
        currency,
        status: 'success',
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
        mihpayid: gatewayRefId,
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
    const refundId = `payuref_${crypto.randomUUID()}`;
    return {
      success: true,
      gatewayReferenceId: refundId,
      status: 'refunded',
      rawResponse: {
        refund_id: refundId,
        status: 'success',
      },
    };
  }

  public async voidPayment(transactionId: string, gatewayRefId: string, traceId: string): Promise<GatewayResponse> {
    return {
      success: true,
      gatewayReferenceId: gatewayRefId,
      status: 'voided',
      rawResponse: {
        status: 'voided',
      },
    };
  }

  public verifyWebhookSignature(headers: Record<string, string>, rawBody: string, secret: string): boolean {
    try {
      const payuSig = headers['x-payu-signature'] || headers['X-Payu-Signature'];
      const fallbackSig = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
      const signatureToVerify = payuSig || fallbackSig;

      if (!signatureToVerify) return false;

      // Recompute Signature
      const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      // Check timestamp header if present
      const timestampHeader = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];
      if (timestampHeader) {
        const now = Math.floor(Date.now() / 1000);
        const timeDiff = Math.abs(now - parseInt(timestampHeader, 10));
        if (timeDiff > 300) {
          logger.error(`PayU webhook signature timestamp validation failed. Time delta: ${timeDiff}s`);
          return false;
        }
      }

      return this.safeCompare(signatureToVerify, computed);
    } catch (err: any) {
      logger.error('PayU signature verification exception', { error: err.message });
      return false;
    }
  }

  public parseWebhookEvent(body: any): ParsedWebhookEvent {
    const transactionId = body.transaction_id || body.gateway_reference?.replace('payu_', '') || '';
    const status = body.status === 'SUCCESS' ? 'captured' : 'failed';
    const amount = BigInt(body.amount);

    return {
      eventId: body.event_id || `evt_${crypto.randomUUID()}`,
      transactionId,
      status,
      amountPaise: amount,
      gatewayReferenceId: body.gateway_reference || `payu_${transactionId}`,
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
