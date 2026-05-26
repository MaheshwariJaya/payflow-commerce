import { PrismaClient, GatewayHealthMetrics, CircuitState } from '@prisma/client';
import { logger } from '../utils/logger';

export interface RouteOption {
  gatewayName: string;
  score: number;
  costEstimatePaise: bigint;
  avgLatencyMs: number;
  circuitState: CircuitState;
}

export class RoutingEngine {
  public static async selectRoute(
    prisma: PrismaClient,
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    traceId: string,
  ): Promise<RouteOption[]> {
    const gateways = await prisma.gatewayConfig.findMany({
      where: { is_active: true },
    });

    if (gateways.length === 0) {
      throw new Error('No active gateway configurations found.');
    }

    const candidates = gateways.filter((gw) =>
      gw.supported_methods.map((m) => m.toUpperCase()).includes(paymentMethod.toUpperCase()),
    );

    if (candidates.length === 0) {
      throw new Error(`No active gateways support payment method: ${paymentMethod}`);
    }

    const routingConfig = await prisma.routingConfig.findFirst();
    if (!routingConfig) {
      throw new Error('Routing configuration weights not found in database.');
    }

    const {
      success_rate_weight: wSuccess,
      latency_weight: wLatency,
      cost_weight: wCost,
      health_weight: wHealth,
      payment_method_fit_weight: wFit,
      priority_matrix,
    } = routingConfig;

    logger.info('Routing weights fetched in selectRoute:', {
      wSuccess,
      wLatency,
      wCost,
      wHealth,
      wFit,
    });

    const healthMetricsList = await prisma.gatewayHealthMetrics.findMany({
      where: {
        gateway_name: { in: candidates.map((c) => c.name) },
        payment_method: paymentMethod.toUpperCase(),
      },
    });

    const metricsMap = new Map<string, GatewayHealthMetrics>();
    for (const metric of healthMetricsList) {
      metricsMap.set(metric.gateway_name, metric);
    }

    const candidateData = candidates.map((gw) => {
      const metric = metricsMap.get(gw.name);

      const successRate = metric ? metric.success_rate : gw.success_rate;
      const latency = metric ? metric.avg_latency_ms : gw.avg_latency_ms;
      const circuitState = metric ? metric.state : CircuitState.CLOSED;

      const costEstimate = Number(gw.cost_per_tx_paise) + gw.cost_percentage * Number(amountPaise);

      let healthMultiplier = 1.0;
      if (circuitState === CircuitState.HALF_OPEN) {
        healthMultiplier = 0.5;
      } else if (circuitState === CircuitState.OPEN) {
        healthMultiplier = 0.0;
      }

      let fitScore = 0.1;
      const priorityList = priority_matrix ? (priority_matrix as any)[paymentMethod.toUpperCase()] : null;
      if (Array.isArray(priorityList)) {
        const index = priorityList.indexOf(gw.name);
        if (index !== -1) {
          fitScore = 1.0 - index / priorityList.length;
        }
      }

      return {
        gateway: gw,
        successRate,
        latency,
        costEstimate,
        circuitState,
        healthMultiplier,
        fitScore,
      };
    });

    const latencies = candidateData.map((d) => d.latency);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const latencyRange = maxLatency - minLatency;

    const costs = candidateData.map((d) => d.costEstimate);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const costRange = maxCost - minCost;

    const options: RouteOption[] = candidateData.map((data) => {
      const normalizedLatency = latencyRange > 0 ? (data.latency - minLatency) / latencyRange : 0;
      const latencyScore = 1 - normalizedLatency;

      const normalizedCost = costRange > 0 ? (data.costEstimate - minCost) / costRange : 0;
      const costScore = 1 - normalizedCost;

      const score =
        wSuccess * data.successRate +
        wLatency * latencyScore +
        wCost * costScore +
        wHealth * data.healthMultiplier +
        wFit * data.fitScore;

      return {
        gatewayName: data.gateway.name,
        score,
        costEstimatePaise: BigInt(Math.round(data.costEstimate)),
        avgLatencyMs: data.latency,
        circuitState: data.circuitState,
      };
    });

    const sortedOptions = options.sort((a, b) => {
      const aOpen = a.circuitState === CircuitState.OPEN ? 1 : 0;
      const bOpen = b.circuitState === CircuitState.OPEN ? 1 : 0;
      if (aOpen !== bOpen) {
        return aOpen - bOpen;
      }
      return b.score - a.score;
    });

    logger.info(`Computed gateway routing scores for ${paymentMethod}`, {
      paymentMethod,
      options: sortedOptions.map((o) => ({
        gateway: o.gatewayName,
        score: o.score,
        circuitState: o.circuitState,
        latencyMs: o.avgLatencyMs,
        costPaise: o.costEstimatePaise.toString(),
      })),
      trace_id: traceId,
    });

    return sortedOptions;
  }
}
