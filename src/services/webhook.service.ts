import { PrismaClient, WebhookStatus } from '@prisma/client';
import { GatewayFactory } from '../gateways/gateway.factory';
import { QueueService } from '../queue/queue.service';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export class WebhookService {
  /**
   * Receives and validates raw webhooks, then enqueues them for asynchronous processing.
   */
  public static async receiveWebhook(
    gateway: string,
    headers: Record<string, string>,
    rawBody: string,
    traceId: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info(`Received webhook from ${gateway}`, { gateway, trace_id: traceId });

    // 1. Load active gateway config & webhook secret
    const config = await prisma.gatewayConfig.findUnique({
      where: { name: gateway },
    });

    if (!config || !config.api_secret) {
      const msg = `Gateway configuration or webhook secret not found for ${gateway}`;
      logger.error(msg);
      return { success: false, message: msg };
    }

    // Decrypt the webhook secret
    const decryptSecret = await import('../utils/crypto.util').then((m) =>
      m.CryptoUtil.decrypt(config.api_secret!)
    );

    // 2. Validate webhook signature & timestamp protection
    const adapter = GatewayFactory.getAdapter(gateway);
    const isValid = adapter.verifyWebhookSignature(headers, rawBody, decryptSecret);

    if (!isValid) {
      const msg = `Invalid webhook signature or timestamp for ${gateway}`;
      logger.warn(msg, { headers });
      return { success: false, message: msg };
    }

    // 3. Parse payload to extract unique event ID
    const parsedBody = JSON.parse(rawBody);
    const parsedEvent = adapter.parseWebhookEvent(parsedBody);
    const eventId = parsedEvent.eventId;

    // 4. Deduplicate (Check ProcessedWebhookEvent table)
    const existingProcessed = await prisma.processedWebhookEvent.findUnique({
      where: {
        gateway_event_id: {
          gateway,
          event_id: eventId,
        },
      },
    });

    if (existingProcessed) {
      logger.info(`Duplicate webhook event already processed: ${gateway} - ${eventId}`);
      return { success: true, message: 'Webhook already processed.' };
    }

    // 5. Check if it's already in the queue to prevent double-enqueuing
    const existingQueueLog = await prisma.webhookQueueLog.findFirst({
      where: { gateway, event_id: eventId, status: { in: [WebhookStatus.QUEUED, WebhookStatus.PROCESSING] } },
    });

    if (existingQueueLog) {
      logger.info(`Webhook event is already in the queue: ${gateway} - ${eventId}`);
      return { success: true, message: 'Webhook already queued.' };
    }

    // 6. Log the queue item in DB and enqueue in BullMQ
    await prisma.webhookQueueLog.create({
      data: {
        event_id: eventId,
        gateway,
        payload: parsedBody,
        status: WebhookStatus.QUEUED,
        trace_id: traceId,
      },
    });

    await QueueService.enqueueWebhook(gateway, eventId, parsedBody, traceId);

    logger.info(`Successfully queued webhook event for processing`, {
      gateway,
      event_id: eventId,
      transaction_id: parsedEvent.transactionId,
    });

    return { success: true, message: 'Webhook successfully queued.' };
  }

  /**
   * Replays a failed/dead webhook by re-enqueuing it.
   */
  public static async replayWebhook(
    eventId: string,
    traceId: string
  ): Promise<{ success: boolean; message: string }> {
    // Check WebhookQueueLog or DeadLetterQueue
    const logItem = await prisma.webhookQueueLog.findFirst({
      where: { event_id: eventId },
    });

    let payload: any = null;
    let gateway: string = '';

    if (logItem) {
      payload = logItem.payload;
      gateway = logItem.gateway;
    } else {
      const dlqItem = await prisma.deadLetterQueue.findFirst({
        where: { event_id: eventId },
      });
      if (dlqItem) {
        payload = dlqItem.payload;
        gateway = dlqItem.gateway;
      }
    }

    if (!payload || !gateway) {
      throw new Error(`Webhook event with ID ${eventId} not found in Queue Logs or DLQ.`);
    }

    // Update status to QUEUED
    if (logItem) {
      await prisma.webhookQueueLog.update({
        where: { id: logItem.id },
        data: {
          status: WebhookStatus.QUEUED,
          attempts: 0,
          error_message: null,
          trace_id: traceId,
        },
      });
    }

    // Enqueue again
    await QueueService.enqueueWebhook(gateway, eventId, payload, traceId);
    
    logger.info(`Requeued webhook replay for ${gateway} - ${eventId}`, { trace_id: traceId });
    return { success: true, message: `Webhook ${eventId} successfully requeued for replay.` };
  }
}
