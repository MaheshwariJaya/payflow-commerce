import { Request, Response } from 'express';
import { SimulatorService } from '../gateways/simulator.service';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

export class SimulatorController {
  public static async stripePaymentIntents(req: Request, res: Response): Promise<void> {
    const { amount, currency, metadata } = req.body;
    const txId = metadata?.transaction_id || `sim_${crypto.randomUUID()}`;
    const orderId = req.body.description || '';

    const trigger = SimulatorService.parseTrigger('Stripe', orderId, metadata);
    logger.info('Simulator: Stripe payment request received', { trigger });

    if (trigger.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, trigger.latencyMs));
    }

    if (trigger.scenario === 'TIMEOUT') {
      return;
    }
    if (trigger.scenario === 'ERROR_500') {
      res.status(500).json({ error: { message: 'Internal Server Error' } });
      return;
    }
    if (trigger.scenario === 'FAILURE') {
      res.status(400).json({ error: { message: 'Card declined' } });
      return;
    }

    const ref = `pi_${txId}`;

    const stripeWebhookStatus = trigger.scenario === ('AUTH_ONLY' as any) ? 'authorised' : 'captured';
    SimulatorService.triggerAsynchronousWebhook(
      'Stripe',
      `evt_${crypto.randomUUID()}`,
      txId,
      BigInt(Math.round(Number(amount) * 100)),
      currency || 'INR',
      stripeWebhookStatus,
      500,
    );

    res.status(200).json({
      id: ref,
      object: 'payment_intent',
      amount,
      currency,
      status: 'requires_capture',
      metadata,
    });
  }

  public static async razorpayOrders(req: Request, res: Response): Promise<void> {
    const { amount, currency, notes } = req.body;
    const txId = notes?.transaction_id || `sim_${crypto.randomUUID()}`;
    const orderId = notes?.merchant_order_id || '';

    const trigger = SimulatorService.parseTrigger('Razorpay', orderId, notes);
    logger.info('Simulator: Razorpay order request received', { trigger });

    if (trigger.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, trigger.latencyMs));
    }

    if (trigger.scenario === 'TIMEOUT') {
      return;
    }
    if (trigger.scenario === 'ERROR_500') {
      res.status(500).json({ error: { description: 'Internal Server Error' } });
      return;
    }
    if (trigger.scenario === 'FAILURE') {
      res.status(400).json({ error: { description: 'Payment failed validation' } });
      return;
    }

    const orderRef = `order_${txId}`;

    const razorpayWebhookStatus = trigger.scenario === ('AUTH_ONLY' as any) ? 'authorised' : 'captured';
    SimulatorService.triggerAsynchronousWebhook(
      'Razorpay',
      `evt_${crypto.randomUUID()}`,
      txId,
      BigInt(amount),
      currency || 'INR',
      razorpayWebhookStatus,
      500,
    );

    res.status(200).json({
      id: orderRef,
      entity: 'order',
      amount,
      currency,
      status: 'created',
      notes,
    });
  }

  public static async payuPayment(req: Request, res: Response): Promise<void> {
    const { amount, txnid, productinfo, key: _key } = req.body;
    const trigger = SimulatorService.parseTrigger('PayU', productinfo || '', req.body);
    logger.info('Simulator: PayU payment request received', { trigger });

    if (trigger.scenario === 'TIMEOUT') {
      return;
    }
    if (trigger.scenario === 'ERROR_500') {
      res.status(500).json({ status: 'failure', error: 'Internal Server Error' });
      return;
    }
    if (trigger.scenario === 'FAILURE') {
      res.status(400).json({ status: 'failure', error: 'Card validation error' });
      return;
    }

    SimulatorService.triggerAsynchronousWebhook(
      'PayU',
      `evt_${crypto.randomUUID()}`,
      txnid,
      BigInt(Math.round(Number(amount) * 100)),
      'INR',
      'captured',
      500,
    );

    res.status(200).json({
      status: 'success',
      mihpayid: `payu_${txnid}`,
      amount,
      txnid,
    });
  }

  public static async upiPay(req: Request, res: Response): Promise<void> {
    const { amount, txn_id, note } = req.body;
    const trigger = SimulatorService.parseTrigger('UPI', note || '', req.body);
    logger.info('Simulator: UPI payment request received', { trigger });

    if (trigger.scenario === 'TIMEOUT') {
      return;
    }
    if (trigger.scenario === 'ERROR_500') {
      res.status(500).json({ status: 'FAILURE', error: 'Bank server down' });
      return;
    }
    if (trigger.scenario === 'FAILURE') {
      res.status(400).json({ status: 'FAILURE', error: 'VPA Not Found' });
      return;
    }

    SimulatorService.triggerAsynchronousWebhook(
      'UPI',
      `evt_${crypto.randomUUID()}`,
      txn_id,
      BigInt(Math.round(Number(amount) * 100)),
      'INR',
      'captured',
      500,
    );

    res.status(200).json({
      status: 'PENDING',
      vpa_txn_id: `upi_${txn_id}`,
      amount,
    });
  }
}
