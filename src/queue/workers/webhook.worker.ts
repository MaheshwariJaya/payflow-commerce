import { Worker, Job } from 'bullmq';
import { PrismaClient, WebhookStatus, TransactionState } from '@prisma/client';
import { GatewayFactory } from '../../gateways/gateway.factory';
import { TransactionStateMachine } from '../../state-machine/transaction-state-machine';
import { redis } from '../../config/redis';
import { logger, traceStore } from '../../utils/logger';

const prisma = new PrismaClient();

export const webhookWorker = new Worker(
  'webhook-queue',
  async (job: Job) => {
    const { gateway, eventId, payload, traceId } = job.data;

    // Set up AsyncLocalStorage trace logging context inside the worker execution thread
    const store = new Map<string, string>();
    store.set('trace_id', traceId);
    store.set('gateway', gateway);
    store.set('action', 'webhook_worker');

    return traceStore.run(store, async () => {
      logger.info(`Webhook worker processing event: ${gateway} - ${eventId}`, { job_id: job.id });

      try {
        // 1. Double check ProcessedWebhookEvent deduplication
        const existing = await prisma.processedWebhookEvent.findUnique({
          where: {
            gateway_event_id: {
              gateway,
              event_id: eventId,
            },
          },
        });

        if (existing) {
          logger.info(`Deduplication: Webhook event already processed. No-op.`);
          await updateQueueLog(eventId, WebhookStatus.PROCESSED);
          return { status: 'duplicate' };
        }

        // 2. Update status in log to PROCESSING
        await updateQueueLog(eventId, WebhookStatus.PROCESSING);

        // 3. Parse Webhook
        const adapter = GatewayFactory.getAdapter(gateway);
        const parsedEvent = adapter.parseWebhookEvent(payload);
        const transactionId = parsedEvent.transactionId;

        store.set('transaction_id', transactionId);

        // Find Transaction in DB
        const transaction = await prisma.transaction.findUnique({
          where: { id: transactionId },
        });

        if (!transaction) {
          const msg = `Reconciliation anomaly: Webhook event reference mapping failed. Transaction ${transactionId} not found.`;
          logger.error(msg);

          // Insert anomaly
          await prisma.reconciliationAnomaly.create({
            data: {
              transaction_id: null,
              gateway,
              internal_state: 'NOT_FOUND',
              gateway_state: parsedEvent.status.toUpperCase(),
              severity: 'HIGH',
              notes: `Orphaned webhook received for event_id=${eventId}. Tx reference ID=${transactionId} does not exist locally.`,
            },
          });

          await updateQueueLog(eventId, WebhookStatus.FAILED, msg);
          throw new Error(msg);
        }

        // 4. State Machine Transition (compensating state steps run automatically if out-of-order)
        let targetState: TransactionState = TransactionState.CAPTURED;
        if (parsedEvent.status === 'failed') {
          targetState = TransactionState.FAILED;
        } else if (parsedEvent.status === 'refunded') {
          targetState = TransactionState.REFUNDED;
        } else if (parsedEvent.status === 'authorised') {
          targetState = TransactionState.AUTHORISED;
        } else if (parsedEvent.status === 'voided') {
          targetState = TransactionState.VOIDED;
        }

        await prisma.$transaction(async (txPrisma) => {
          await TransactionStateMachine.transition(
            txPrisma,
            transactionId,
            targetState,
            'webhook_processor',
            `Processed gateway event: ${eventId}`,
            parsedEvent.rawPayload,
            traceId
          );

          // Deduplicate future hits
          await txPrisma.processedWebhookEvent.create({
            data: {
              event_id: eventId,
              gateway,
              status: 'PROCESSED',
              payload: payload,
            },
          });
        });

        // 5. Success Log Update
        await updateQueueLog(eventId, WebhookStatus.PROCESSED);
        logger.info(`Successfully finished webhook processing`, { event_id: eventId });

        return { status: 'success' };
      } catch (err: any) {
        logger.error(`Webhook processing worker exception`, { error: err.message, event_id: eventId });

        const isFinalAttempt = (job.attemptsMade || 0) >= (job.opts.attempts || 5) - 1;

        if (isFinalAttempt) {
          // Put in DLQ database table
          await prisma.deadLetterQueue.create({
            data: {
              event_id: eventId,
              gateway,
              payload: payload,
              error_message: err.message || 'Exhausted retry limits',
            },
          });
          await updateQueueLog(eventId, WebhookStatus.DEAD, err.message);
        } else {
          await updateQueueLog(eventId, WebhookStatus.RETRYING, err.message);
        }

        throw err; // Signal BullMQ to retry
      }
    });
  },
  { connection: redis }
);

async function updateQueueLog(eventId: string, status: WebhookStatus, errorMsg: string | null = null) {
  try {
    await prisma.webhookQueueLog.updateMany({
      where: { event_id: eventId },
      data: {
        status,
        attempts: { increment: status === WebhookStatus.PROCESSING ? 0 : 1 },
        error_message: errorMsg,
        updated_at: new Date(),
      },
    });
  } catch (err) {
    console.error('Error updating webhook queue log:', err);
  }
}
