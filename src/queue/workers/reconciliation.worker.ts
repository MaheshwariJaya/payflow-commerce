import { Worker, Job } from 'bullmq';
import { ReconciliationService } from '../../services/reconciliation.service';
import { redis } from '../../config/redis';
import { logger, traceStore } from '../../utils/logger';

export const reconciliationWorker = new Worker(
  'reconciliation-queue',
  async (job: Job) => {
    const { transactionId, traceId } = job.data;

    const store = new Map<string, string>();
    store.set('trace_id', traceId);
    store.set('transaction_id', transactionId);
    store.set('action', 'reconciliation_worker');

    return traceStore.run(store, async () => {
      logger.info(`Reconciliation worker checking transaction: ${transactionId}`);

      try {
        await ReconciliationService.reconcileTransaction(transactionId, traceId);
        logger.info(`Reconciliation checks completed for transaction: ${transactionId}`);
      } catch (err: any) {
        logger.error(`Reconciliation worker failed`, { error: err.message, transaction_id: transactionId });
        throw err;
      }
    });
  },
  { connection: redis }
);
