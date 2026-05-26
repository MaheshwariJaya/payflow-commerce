import { Queue } from 'bullmq';
import { redis } from '../config/redis';

export const webhookQueue = new Queue('webhook-queue', { connection: redis });
export const reconciliationQueue = new Queue('reconciliation-queue', {
  connection: redis,
});
export const metricsQueue = new Queue('metrics-queue', { connection: redis });
export const retryQueue = new Queue('retry-queue', { connection: redis });
export const settlementQueue = new Queue('settlement-queue', {
  connection: redis,
});

export class QueueService {
  public static async enqueueWebhook(gateway: string, eventId: string, payload: any, traceId: string): Promise<void> {
    await webhookQueue.add(
      'process-webhook',
      { gateway, eventId, payload, traceId },
      {
        jobId: `${gateway}_${eventId}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    );
  }

  public static async enqueueReconciliation(transactionId: string, traceId: string): Promise<void> {
    await reconciliationQueue.add(
      'reconcile-transaction',
      { transactionId, traceId },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );
  }

  public static async enqueueSettlement(transactionId: string, traceId: string): Promise<void> {
    await settlementQueue.add(
      'process-settlement',
      { transactionId, traceId },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    );
  }
}
