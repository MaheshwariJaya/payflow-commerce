import { PrismaClient, GatewayConfig, GatewayHealthMetrics, CircuitState } from '@prisma/client';
import { logger } from '../utils/logger';

export interface RouteOption {
  gatewayName: string;
  score: number;
  costEstimatePaise: bigint;
  avgLatencyMs: number;
  circuitState: CircuitState;
}

export class RoutingEngine {
  /**
   * Evaluates all gateways and returns sorted routing options based on the scoring formula.
   */
  public static async selectRoute(
    prisma: PrismaClient,
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    traceId: string
  ): Promise<RouteOption[]> {
    // 1. Fetch active Gateway Configurations
    const gateways = await prisma.gatewayConfig.findMany({
      where: { is_active: true },
    });

    if (gateways.length === 0) {
      throw new Error('No active gateway configurations found.');
    }

    // Filter gateways that support the payment method
    const candidates = gateways.filter((gw) =>
      gw.supported_methods.map((m) => m.toUpperCase()).includes(paymentMethod.toUpperCase())
    );

    if (candidates.length === 0) {
      throw new Error(`No active gateways support payment method: ${paymentMethod}`);
    }

    // 2. Fetch routing weights configuration
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

    logger.info('Routing weights fetched in selectRoute:', { wSuccess, wLatency, wCost, wHealth, wFit });

    // 3. Fetch health metrics for the candidates
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

    // 4. Calculate raw metrics for all candidates
    const candidateData = candidates.map((gw) => {
      const metric = metricsMap.get(gw.name);

      const successRate = metric ? metric.success_rate : gw.success_rate;
      const latency = metric ? metric.avg_latency_ms : gw.avg_latency_ms;
      const circuitState = metric ? metric.state : CircuitState.CLOSED;

      // Estimate transaction cost: cost_per_tx_paise + (cost_percentage * amount_paise)
      // Represent cost in paise (can be float or bigint, we'll use bigint or float for normalized calculation)
      const costEstimate = Number(gw.cost_per_tx_paise) + gw.cost_percentage * Number(amountPaise);

      // Gateway health multiplier
      let healthMultiplier = 1.0;
      if (circuitState === CircuitState.HALF_OPEN) {
        healthMultiplier = 0.5;
      } else if (circuitState === CircuitState.OPEN) {
        healthMultiplier = 0.0;
      }

      // Priority Fit score based on matrix config
      let fitScore = 0.1; // Baseline score
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

    // 5. Normalization values
    const latencies = candidateData.map((d) => d.latency);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const latencyRange = maxLatency - minLatency;

    const costs = candidateData.map((d) => d.costEstimate);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const costRange = maxCost - minCost;

    // 6. Calculate scoring
    const options: RouteOption[] = candidateData.map((data) => {
      // Latency Score (Lower latency -> NormalizedLatency closer to 0 -> LatencyScore closer to 1)
      const normalizedLatency = latencyRange > 0 ? (data.latency - minLatency) / latencyRange : 0;
      const latencyScore = 1 - normalizedLatency;

      // Cost Score (Lower cost -> NormalizedCost closer to 0 -> CostScore closer to 1)
      const normalizedCost = costRange > 0 ? (data.costEstimate - minCost) / costRange : 0;
      const costScore = 1 - normalizedCost;

      // Routing engine score formula
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

    // Sort:
    // First priority: CLOSED/HALF_OPEN circuits before OPEN circuits (avoid routing to OPEN circuits)
    // Second priority: descending score
    const sortedOptions = options.sort((a, b) => {
      const aOpen = a.circuitState === CircuitState.OPEN ? 1 : 0;
      const bOpen = b.circuitState === CircuitState.OPEN ? 1 : 0;
      if (aOpen !== bOpen) {
        return aOpen - bOpen; // CLOSED (0) comes before OPEN (1)
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
