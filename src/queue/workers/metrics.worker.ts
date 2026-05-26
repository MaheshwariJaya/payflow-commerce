import { Worker, Job } from 'bullmq';
import { PrismaClient, CircuitState } from '@prisma/client';
import { redis } from '../../config/redis';
import { logger, traceStore } from '../../utils/logger';

const prisma = new PrismaClient();

export const metricsWorker = new Worker(
  'metrics-queue',
  async (job: Job) => {
    const traceId = job.data.traceId || 'metrics-cron-trace';

    const store = new Map<string, string>();
    store.set('trace_id', traceId);
    store.set('action', 'metrics_worker');

    return traceStore.run(store, async () => {
      logger.info('Running gateway metrics aggregation job (P95 and rolling success rates)...');

      try {
        // Query transactions in the last 1 hour
        const oneHourAgo = new Date(Date.now() - 3600 * 1000);

        // Fetch all transactions from the last hour
        const transactions = await prisma.transaction.findMany({
          where: {
            created_at: { gte: oneHourAgo },
            gateway_name: { not: null },
          },
          include: {
            state_logs: true,
          },
        });

        // Group transactions by Gateway + PaymentMethod
        const groups: Record<string, typeof transactions> = {};
        for (const tx of transactions) {
          const key = `${tx.gateway_name}:${tx.payment_method}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push(tx);
        }

        for (const [key, group] of Object.entries(groups)) {
          const [gatewayName, paymentMethod] = key.split(':');

          const total = group.length;
          const successful = group.filter(
            (tx) => tx.status === 'CAPTURED' || tx.status === 'SETTLED' || tx.status === 'REFUNDED'
          ).length;
          const failed = group.filter((tx) => tx.status === 'FAILED').length;

          const successRate = total > 0 ? successful / total : 1.0;
          const errorRate = total > 0 ? failed / total : 0.0;

          // Latency Calculation:
          // Extract latency from transaction state logs (time diff between ROUTE_SELECTED and AUTH_INITIATED/AUTHORISED/CAPTURED)
          const latencies: number[] = [];
          for (const tx of group) {
            const routeSelectedLog = tx.state_logs.find((l) => l.to_state === 'ROUTE_SELECTED');
            const authLog = tx.state_logs.find(
              (l) => l.to_state === 'AUTH_INITIATED' || l.to_state === 'AUTHORISED' || l.to_state === 'CAPTURED'
            );

            if (routeSelectedLog && authLog) {
              const diff = authLog.created_at.getTime() - routeSelectedLog.created_at.getTime();
              if (diff > 0) {
                latencies.push(diff);
              }
            }
          }

          // Sort to find P95 latency
          let p95LatencyMs = 200; // default fallback
          if (latencies.length > 0) {
            latencies.sort((a, b) => a - b);
            const index = Math.floor(0.95 * latencies.length);
            p95LatencyMs = latencies[index];
          }

          // Update GatewayHealthMetrics table
          const metric = await prisma.gatewayHealthMetrics.findUnique({
            where: {
              gateway_name_payment_method: {
                gateway_name: gatewayName,
                payment_method: paymentMethod,
              },
            },
          });

          if (metric) {
            await prisma.gatewayHealthMetrics.update({
              where: { id: metric.id },
              data: {
                success_rate: successRate,
                avg_latency_ms: p95LatencyMs,
                updated_at: new Date(),
              },
            });

            // Sync Redis cache for the updated success rate/latency
            const redisKey = `cb:${gatewayName}:${paymentMethod}`;
            await redis.set(`${redisKey}:state`, metric.state);
            await redis.set(`${redisKey}:last_change`, metric.last_state_change.toISOString());

            logger.info(`Updated metrics for ${gatewayName} - ${paymentMethod}`, {
              total_attempts: total,
              success_rate: successRate,
              p95_latency_ms: p95LatencyMs,
              error_rate: errorRate,
            });
          }

          // Update GatewayConfig table success_rate and latency too
          await prisma.gatewayConfig.updateMany({
            where: { name: gatewayName },
            data: {
              success_rate: successRate,
              avg_latency_ms: p95LatencyMs,
            },
          });
        }

        logger.info('Completed gateway metrics aggregation job successfully.');
      } catch (err: any) {
        logger.error('Gateway metrics aggregation job failed', { error: err.message });
        throw err;
      }
    });
  },
  { connection: redis }
);
