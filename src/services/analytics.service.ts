import { PrismaClient, TransactionState } from '@prisma/client';

const prisma = new PrismaClient();

export class AnalyticsService {
  /**
   * Calculates overall and per-gateway success rates.
   */
  public static async getSuccessRates(): Promise<any> {
    const successStates = [TransactionState.CAPTURED, TransactionState.SETTLED, TransactionState.REFUNDED];
    
    // Global metrics
    const totalTransactions = await prisma.transaction.count();
    const successfulTransactions = await prisma.transaction.count({
      where: { status: { in: successStates } },
    });

    const globalSuccessRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) : 1.0;

    // Per-Gateway metrics
    const gatewayGroup = await prisma.transaction.groupBy({
      by: ['gateway_name'],
      _count: {
        _all: true,
      },
    });

    const gatewaySuccessGroup = await prisma.transaction.groupBy({
      by: ['gateway_name'],
      where: { status: { in: successStates } },
      _count: {
        _all: true,
      },
    });

    const successMap = new Map<string, number>();
    for (const gw of gatewaySuccessGroup) {
      if (gw.gateway_name) {
        successMap.set(gw.gateway_name, gw._count._all);
      }
    }

    const perGateway = gatewayGroup
      .filter((g) => g.gateway_name !== null)
      .map((g) => {
        const gwName = g.gateway_name!;
        const total = g._count._all;
        const success = successMap.get(gwName) || 0;
        const rate = total > 0 ? success / total : 1.0;
        return {
          gateway: gwName,
          total_attempts: total,
          successful: success,
          success_rate: rate,
        };
      });

    return {
      global: {
        total_attempts: totalTransactions,
        successful: successfulTransactions,
        success_rate: globalSuccessRate,
      },
      gateways: perGateway,
    };
  }

  /**
   * Calculates transaction volume in paise/cents grouped by currency and gateway.
   */
  public static async getVolume(): Promise<any> {
    const successStates = [TransactionState.CAPTURED, TransactionState.SETTLED, TransactionState.REFUNDED];

    const volumeGroup = await prisma.transaction.groupBy({
      by: ['currency', 'gateway_name'],
      where: { status: { in: successStates } },
      _sum: {
        amount_paise: true,
      },
      _count: {
        _all: true,
      },
    });

    return volumeGroup.map((v) => ({
      currency: v.currency,
      gateway: v.gateway_name || 'SYSTEM',
      transaction_count: v._count._all,
      volume_paise: v._sum.amount_paise?.toString() || '0',
    }));
  }

  /**
   * Gathers dashboard diagnostic indicators including circuit breaker status, DLQ depth, and reconciliation anomalies.
   */
  public static async getDashboardStats(): Promise<any> {
    // 1. Get Circuit States
    const healthMetrics = await prisma.gatewayHealthMetrics.findMany({});
    const circuits = healthMetrics.map((hm) => ({
      gateway: hm.gateway_name,
      payment_method: hm.payment_method,
      state: hm.state,
      failure_count: hm.failure_count,
      success_count: hm.success_count,
      success_rate: hm.success_rate,
      avg_latency_ms: hm.avg_latency_ms,
    }));

    // 2. DLQ Depth
    const dlqDepth = await prisma.deadLetterQueue.count();
    const webhookQueueDepth = await prisma.webhookQueueLog.count({
      where: { status: 'QUEUED' },
    });

    // 3. Reconciliation anomalies count
    const activeAnomalies = await prisma.reconciliationAnomaly.count({
      where: { resolved: false },
    });

    // 4. Volume and success rates
    const successRateInfo = await this.getSuccessRates();
    const volumeInfo = await this.getVolume();

    return {
      circuits,
      queues: {
        dead_letter_queue_depth: dlqDepth,
        webhook_backlog: webhookQueueDepth,
      },
      reconciliation: {
        unresolved_anomalies: activeAnomalies,
      },
      analytics: {
        success_rate: successRateInfo,
        volume: volumeInfo,
      },
    };
  }
}
