import { Worker, Job } from 'bullmq';
import { PrismaClient, TransactionState } from '@prisma/client';
import { redis } from '../../config/redis';
import { logger, traceStore } from '../../utils/logger';

const prisma = new PrismaClient();

export const retryWorker = new Worker(
  'retry-queue',
  async (job: Job) => {
    const { transactionId, traceId } = job.data;

    const store = new Map<string, string>();
    store.set('trace_id', traceId);
    store.set('transaction_id', transactionId);
    store.set('action', 'retry_worker');

    return traceStore.run(store, async () => {
      logger.info(`Retry worker evaluating transaction: ${transactionId}`);

      try {
        const tx = await prisma.transaction.findUnique({
          where: { id: transactionId },
        });

        if (!tx) {
          logger.error(`Transaction ${transactionId} not found, skipping retry.`);
          return;
        }

        if (tx.status !== TransactionState.FAILED) {
          logger.info(`Transaction is in state ${tx.status}. No retry needed.`);
          return;
        }

        if (tx.retry_count >= 3) {
          logger.warn(`Transaction ${transactionId} has exhausted max retry count (3). Marking terminal.`);
          return;
        }

        logger.info(`Triggering retry attempt ${tx.retry_count + 1} for transaction ${transactionId}`);

        await prisma.transaction.update({
          where: { id: transactionId },
          data: {
            retry_count: { increment: 1 },
          },
        });

        const routes = await RoutingEngineRetryHelper.retryRouting(tx, traceId);

        if (routes.success) {
          logger.info(`Retry attempt succeeded for transaction ${transactionId}`);
        } else {
          const updatedTx = await prisma.transaction.findUnique({
            where: { id: transactionId },
          });

          if (updatedTx && updatedTx.retry_count < 3) {
            await scheduleNextRetry(transactionId, updatedTx.retry_count, traceId);
          }
        }
      } catch (err: any) {
        logger.error(`Retry worker failed to process transaction: ${transactionId}`, { error: err.message });
        throw err;
      }
    });
  },
  { connection: redis },
);

async function scheduleNextRetry(transactionId: string, retryCount: number, traceId: string) {
  const baseDelay = 1000;
  const backoff = baseDelay * Math.pow(2, retryCount);
  const jitter = Math.floor(Math.random() * 500);
  const totalDelay = backoff + jitter;

  const nextRetryAt = new Date(Date.now() + totalDelay);

  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      next_retry_at: nextRetryAt,
    },
  });

  const { retryQueue } = await import('../queue.service');
  await retryQueue.add('retry-payment', { transactionId, traceId }, { delay: totalDelay });

  logger.info(`Scheduled next retry attempt in ${totalDelay}ms (at ${nextRetryAt.toISOString()})`, {
    transaction_id: transactionId,
  });
}

class RoutingEngineRetryHelper {
  public static async retryRouting(tx: any, traceId: string): Promise<{ success: boolean }> {
    const { RoutingEngine } = await import('../../routing-engine/routing-engine');
    const { GatewayFactory } = await import('../../gateways/gateway.factory');
    const { GatewayRateLimiter } = await import('../../middleware/rate-limiter');
    const { CircuitBreakerManager } = await import('../../gateways/circuit-breaker.manager');
    const { TransactionStateMachine } = await import('../../state-machine/transaction-state-machine');
    const { withTimeout } = await import('../../utils/timeout.util');

    try {
      const routes = await RoutingEngine.selectRoute(prisma, tx.amount_paise, tx.currency, tx.payment_method, traceId);

      for (const route of routes) {
        const gatewayName = route.gatewayName;

        const hasTokens = await GatewayRateLimiter.tryAcquire(gatewayName);
        if (!hasTokens) continue;

        const isAvailable = await CircuitBreakerManager.isAvailable(gatewayName, tx.payment_method, prisma, traceId);
        if (!isAvailable) continue;

        try {
          await prisma.$transaction(async (txPrisma) => {
            await txPrisma.transaction.update({
              where: { id: tx.id },
              data: { gateway_name: gatewayName },
            });
            await TransactionStateMachine.transition(
              txPrisma,
              tx.id,
              TransactionState.ROUTE_SELECTED,
              'retry_worker',
              `Retry routing to ${gatewayName}`,
              null,
              traceId,
            );
          });

          const adapter = GatewayFactory.getAdapter(gatewayName);
          const startTime = Date.now();

          const response = await withTimeout(
            async () =>
              adapter.initializePayment(
                tx.id,
                tx.amount_paise,
                tx.currency,
                tx.payment_method,
                tx.merchant_order_id,
                tx.metadata,
                traceId,
              ),
            2000,
            `Retry Gateway: ${gatewayName}`,
          );

          const latency = Date.now() - startTime;

          if (response.success && response.gatewayReferenceId) {
            await CircuitBreakerManager.recordSuccess(gatewayName, tx.payment_method, latency, prisma, traceId);

            await prisma.$transaction(async (txPrisma) => {
              await txPrisma.transaction.update({
                where: { id: tx.id },
                data: { gateway_reference_id: response.gatewayReferenceId },
              });

              const nextState =
                response.status === 'captured' ? TransactionState.CAPTURED : TransactionState.AUTH_INITIATED;
              await TransactionStateMachine.transition(
                txPrisma,
                tx.id,
                nextState,
                'retry_worker',
                `Retry succeeded via ${gatewayName}`,
                null,
                traceId,
              );
            });

            return { success: true };
          } else {
            await CircuitBreakerManager.recordFailure(
              gatewayName,
              tx.payment_method,
              response.error || 'Retry gateway error',
              prisma,
              traceId,
            );
          }
        } catch (e: any) {
          await CircuitBreakerManager.recordFailure(gatewayName, tx.payment_method, e.message, prisma, traceId);
        }
      }
    } catch (routeErr: any) {
      logger.error('Retry routing engine query failed', {
        error: routeErr.message,
      });
    }

    await prisma.$transaction(async (txPrisma) => {
      await TransactionStateMachine.transition(
        txPrisma,
        tx.id,
        TransactionState.FAILED,
        'retry_worker',
        'Retry routing attempt failed on all pathways',
        null,
        traceId,
      );
    });

    return { success: false };
  }
}
export { scheduleNextRetry };
