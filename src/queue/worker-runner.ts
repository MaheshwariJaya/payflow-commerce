import { webhookWorker } from './workers/webhook.worker';
import { reconciliationWorker } from './workers/reconciliation.worker';
import { metricsWorker } from './workers/metrics.worker';
import { settlementWorker } from './workers/settlement.worker';
import { retryWorker } from './workers/retry.worker';
import { metricsQueue } from './queue.service';
import { logger } from '../utils/logger';

async function startWorkers() {
  logger.info('Starting background queue workers...');

  const workers = [
    { name: 'Webhook Worker', worker: webhookWorker },
    { name: 'Reconciliation Worker', worker: reconciliationWorker },
    { name: 'Metrics Worker', worker: metricsWorker },
    { name: 'Settlement Worker', worker: settlementWorker },
    { name: 'Retry Worker', worker: retryWorker },
  ];

  for (const w of workers) {
    w.worker.on('active', (job) => {
      logger.info(`${w.name} - Job ${job.id} started processing.`);
    });

    w.worker.on('completed', (job) => {
      logger.info(`${w.name} - Job ${job.id} completed successfully.`);
    });

    w.worker.on('failed', (job, err) => {
      logger.error(`${w.name} - Job ${job?.id} failed with error: ${err.message}`);
    });

    w.worker.on('error', (err) => {
      logger.error(`${w.name} - Global worker error:`, { error: err.message });
    });
  }

  try {
    const repeatableJobs = await metricsQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await metricsQueue.removeRepeatableByKey(job.key);
    }

    await metricsQueue.add(
      'rolling-metrics-aggregation',
      { traceId: 'metrics-cron-job' },
      {
        repeat: {
          pattern: '*/5 * * * *',
        },
      },
    );
    logger.info('Successfully scheduled repeatable metrics aggregation cron (every 5 minutes).');
  } catch (err: any) {
    logger.error('Failed to schedule repeatable metrics job', {
      error: err.message,
    });
  }

  logger.info('All queue workers started and listening for jobs.');
}

startWorkers().catch((err) => {
  logger.error('Failed to start queue workers process', { error: err.message });
  process.exit(1);
});
