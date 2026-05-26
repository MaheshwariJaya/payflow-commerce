import { PrismaClient, WebhookStatus } from '@prisma/client';
import { GatewayFactory } from '../gateways/gateway.factory';
import { QueueService } from '../queue/queue.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class WebhookService {
  public static async receiveWebhook(
    gateway: string,
    headers: Record<string, string>,
    rawBody: string,
    traceId: string,
  ): Promise<{ success: boolean; message: string }> {
    logger.info(`Received webhook from ${gateway}`, {
      gateway,
      trace_id: traceId,
    });

    const config = await prisma.gatewayConfig.findUnique({
      where: { name: gateway },
    });

    if (!config || !config.api_secret) {
      const msg = `Gateway configuration or webhook secret not found for ${gateway}`;
      logger.error(msg);
      return { success: false, message: msg };
    }

    const decryptSecret = await import('../utils/crypto.util').then((m) => m.CryptoUtil.decrypt(config.api_secret!));

    const adapter = GatewayFactory.getAdapter(gateway);
    const isValid = adapter.verifyWebhookSignature(headers, rawBody, decryptSecret);

    if (!isValid) {
      const msg = `Invalid webhook signature or timestamp for ${gateway}`;
      logger.warn(msg, { headers });
      return { success: false, message: msg };
    }

    const parsedBody = JSON.parse(rawBody);
    const parsedEvent = adapter.parseWebhookEvent(parsedBody);
    const eventId = parsedEvent.eventId;

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

    const existingQueueLog = await prisma.webhookQueueLog.findFirst({
      where: {
        gateway,
        event_id: eventId,
        status: { in: [WebhookStatus.QUEUED, WebhookStatus.PROCESSING] },
      },
    });

    if (existingQueueLog) {
      logger.info(`Webhook event is already in the queue: ${gateway} - ${eventId}`);
      return { success: true, message: 'Webhook already queued.' };
    }

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

  public static async replayWebhook(eventId: string, traceId: string): Promise<{ success: boolean; message: string }> {
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

    await QueueService.enqueueWebhook(gateway, eventId, payload, traceId);

    logger.info(`Requeued webhook replay for ${gateway} - ${eventId}`, {
      trace_id: traceId,
    });
    return {
      success: true,
      message: `Webhook ${eventId} successfully requeued for replay.`,
    };
  }
}
