import { logger } from '../utils/logger';
import axios from 'axios';

export interface SimulatorTrigger {
  scenario: 'TIMEOUT' | 'ERROR_500' | 'DELAYED_WEBHOOK' | 'OUT_OF_ORDER' | 'SLOW' | 'FAILURE' | 'SUCCESS';
  latencyMs: number;
}

export class SimulatorService {
  public static parseTrigger(gateway: string, merchantOrderId: string, metadata: any): SimulatorTrigger {
    const checkStr = `${merchantOrderId} ${JSON.stringify(metadata || {})}`.toUpperCase();
    const g = gateway.toUpperCase();

    const matches = (scenario: string) => {
      return (
        checkStr.includes(`SIM_${scenario}_${g}`) ||
        (checkStr.includes(`SIM_${scenario}`) && !checkStr.includes(`SIM_${scenario}_`))
      );
    };

    if (matches('TIMEOUT')) {
      return { scenario: 'TIMEOUT', latencyMs: 6000 };
    }
    if (matches('500') || matches('ERROR_500')) {
      return { scenario: 'ERROR_500', latencyMs: 100 };
    }
    if (matches('DELAYED_WEBHOOK')) {
      return { scenario: 'DELAYED_WEBHOOK', latencyMs: 100 };
    }
    if (matches('OUT_OF_ORDER')) {
      return { scenario: 'OUT_OF_ORDER', latencyMs: 50 };
    }
    if (matches('SLOW')) {
      return { scenario: 'SLOW', latencyMs: 1500 };
    }
    if (matches('FAILURE')) {
      return { scenario: 'FAILURE', latencyMs: 100 };
    }
    if (matches('AUTH_ONLY')) {
      return { scenario: 'AUTH_ONLY' as any, latencyMs: 50 };
    }
    return { scenario: 'SUCCESS', latencyMs: 50 };
  }

  public static triggerAsynchronousWebhook(
    gateway: string,
    eventId: string,
    transactionId: string,
    amountPaise: bigint,
    currency: string,
    status: 'captured' | 'failed' | 'authorised',
    delayMs: number,
    duplicate: boolean = false,
  ): void {
    const payload = this.generateWebhookPayload(gateway, eventId, transactionId, amountPaise, currency, status);
    const webhookUrl = `http://localhost:${process.env.PORT || 3000}/api/v1/webhooks/${gateway.toLowerCase()}`;
    const secret = process.env[`${gateway.toUpperCase()}_WEBHOOK_SECRET`] || 'secret';

    const sendCall = async () => {
      try {
        const bodyStr = JSON.stringify(payload);

        const crypto = await import('crypto');
        const signature = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
        const timestamp = Math.floor(Date.now() / 1000).toString();

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestamp,
        };

        if (gateway.toLowerCase() === 'stripe') {
          const stripePayload = `${timestamp}.${bodyStr}`;
          const stripeSig = crypto.createHmac('sha256', secret).update(stripePayload).digest('hex');
          headers['stripe-signature'] = `t=${timestamp},v1=${stripeSig}`;
        } else if (gateway.toLowerCase() === 'razorpay') {
          headers['x-razorpay-signature'] = signature;
        }

        await axios.post(webhookUrl, payload, { headers });
        logger.info(`Simulated webhook delivered to ${gateway}`, {
          transaction_id: transactionId,
          gateway,
          status,
        });

        if (duplicate) {
          setTimeout(async () => {
            try {
              await axios.post(webhookUrl, payload, { headers });
              logger.info(`Simulated duplicate webhook delivered to ${gateway}`, {
                transaction_id: transactionId,
                gateway,
              });
            } catch (err: any) {
              logger.error(`Simulated duplicate webhook delivery failed`, {
                error: err.message,
              });
            }
          }, 1000);
        }
      } catch (err: any) {
        logger.error(`Simulated webhook delivery failed to ${gateway}`, {
          error: err.message,
        });
      }
    };

    setTimeout(sendCall, delayMs);
  }

  private static generateWebhookPayload(
    gateway: string,
    eventId: string,
    transactionId: string,
    amountPaise: bigint,
    currency: string,
    status: 'captured' | 'failed' | 'authorised',
  ): any {
    const amtStr = amountPaise.toString();

    if (gateway.toLowerCase() === 'stripe') {
      return {
        id: eventId,
        object: 'event',
        type:
          status === 'captured'
            ? 'payment_intent.succeeded'
            : status === 'authorised'
              ? 'payment_intent.amount_capturable_updated'
              : 'payment_intent.payment_failed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `pi_${transactionId}`,
            amount: Number(amountPaise) / 100,
            currency: currency.toLowerCase(),
            status:
              status === 'captured'
                ? 'succeeded'
                : status === 'authorised'
                  ? 'requires_capture'
                  : 'requires_payment_method',
            metadata: {
              transaction_id: transactionId,
            },
          },
        },
      };
    }

    if (gateway.toLowerCase() === 'razorpay') {
      return {
        entity: 'event',
        account_id: 'acc_12345',
        event:
          status === 'captured'
            ? 'payment.captured'
            : status === 'authorised'
              ? 'payment.authorized'
              : 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: `pay_${transactionId}`,
              amount: Number(amountPaise),
              currency: currency,
              status: status === 'captured' ? 'captured' : status === 'authorised' ? 'authorized' : 'failed',
              order_id: `order_${transactionId}`,
              notes: {
                transaction_id: transactionId,
              },
            },
          },
        },
        created_at: Math.floor(Date.now() / 1000),
      };
    }

    return {
      event_id: eventId,
      transaction_id: transactionId,
      gateway_reference: `ref_${transactionId}`,
      amount: amtStr,
      status: status === 'captured' ? 'SUCCESS' : 'FAILED',
      timestamp: new Date().toISOString(),
    };
  }
}
