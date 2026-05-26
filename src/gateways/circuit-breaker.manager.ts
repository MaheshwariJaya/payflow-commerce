import { PrismaClient, CircuitState } from '@prisma/client';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const COOLDOWN_PERIOD_MS = 30000; // 30 seconds
const FAILURE_THRESHOLD = 5;      // Max failures before trip
const CONSECUTIVE_SUCCESS_REQ = 3; // Successes in HALF_OPEN to close circuit

export class CircuitBreakerManager {
  /**
   * Checks if a gateway is available for a payment method.
   * If state is OPEN but cooldown has passed, transitions to HALF_OPEN.
   */
  public static async isAvailable(
    gatewayName: string,
    paymentMethod: string,
    prisma: PrismaClient,
    traceId: string
  ): Promise<boolean> {
    const key = `cb:${gatewayName}:${paymentMethod.toUpperCase()}`;
    
    // 1. Read state from Redis cache
    let state = await redis.get(`${key}:state`) as CircuitState | null;
    let lastChangeStr = await redis.get(`${key}:last_change`);

    // 2. Cache miss: read from DB and populate cache
    if (!state || !lastChangeStr) {
      const metric = await prisma.gatewayHealthMetrics.findUnique({
        where: {
          gateway_name_payment_method: {
            gateway_name: gatewayName,
            payment_method: paymentMethod.toUpperCase(),
          },
        },
      });

      if (!metric) {
        // If config doesn't exist, assume CLOSED
        await this.syncRedis(gatewayName, paymentMethod.toUpperCase(), CircuitState.CLOSED, 0, 0, new Date());
        return true;
      }

      state = metric.state;
      lastChangeStr = metric.last_state_change.toISOString();
      await this.syncRedis(gatewayName, paymentMethod.toUpperCase(), state, metric.failure_count, metric.success_count, metric.last_state_change);
    }

    if (state === CircuitState.CLOSED || state === CircuitState.HALF_OPEN) {
      return true;
    }

    // 3. State is OPEN: check if cooldown period has elapsed
    const lastChange = new Date(lastChangeStr);
    const now = new Date();
    const timeElapsed = now.getTime() - lastChange.getTime();

    if (timeElapsed >= COOLDOWN_PERIOD_MS) {
      // Transition to HALF_OPEN (Allow test requests)
      logger.info(`Circuit breaker cooldown elapsed. Transitioning ${gatewayName} - ${paymentMethod} to HALF_OPEN.`, {
        gateway: gatewayName,
        payment_method: paymentMethod,
        trace_id: traceId
      });

      await this.updateState(gatewayName, paymentMethod.toUpperCase(), CircuitState.HALF_OPEN, prisma, traceId);
      return true;
    }

    return false;
  }

  /**
   * Records a success in the circuit.
   */
  public static async recordSuccess(
    gatewayName: string,
    paymentMethod: string,
    latencyMs: number,
    prisma: PrismaClient,
    traceId: string
  ): Promise<void> {
    const key = `cb:${gatewayName}:${paymentMethod.toUpperCase()}`;
    const state = await redis.get(`${key}:state`) as CircuitState || CircuitState.CLOSED;

    await redis.incr(`${key}:successes`);
    await redis.set(`${key}:failures`, '0'); // Reset failures on success

    if (state === CircuitState.HALF_OPEN) {
      const consecutiveSuccesses = await redis.incr(`${key}:consecutive_successes`);
      
      if (consecutiveSuccesses >= CONSECUTIVE_SUCCESS_REQ) {
        logger.info(`Circuit closed for ${gatewayName} - ${paymentMethod} after consecutive successes.`, {
          gateway: gatewayName,
          payment_method: paymentMethod,
          trace_id: traceId
        });
        await this.updateState(gatewayName, paymentMethod.toUpperCase(), CircuitState.CLOSED, prisma, traceId);
      }
    }

    // Update rolling metrics in background
    await this.updateHealthMetricsInDB(gatewayName, paymentMethod.toUpperCase(), latencyMs, true, prisma);
  }

  /**
   * Records a failure in the circuit.
   */
  public static async recordFailure(
    gatewayName: string,
    paymentMethod: string,
    error: string,
    prisma: PrismaClient,
    traceId: string
  ): Promise<void> {
    const key = `cb:${gatewayName}:${paymentMethod.toUpperCase()}`;
    const state = await redis.get(`${key}:state`) as CircuitState || CircuitState.CLOSED;

    const failures = await redis.incr(`${key}:failures`);
    await redis.set(`${key}:consecutive_successes`, '0'); // Reset consecutive successes

    logger.warn(`Recorded gateway call failure on ${gatewayName} - ${paymentMethod}. Current failures: ${failures}`, {
      gateway: gatewayName,
      payment_method: paymentMethod,
      error,
      trace_id: traceId
    });

    if (state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN trips it back to OPEN immediately
      logger.error(`Circuit breaker failure in HALF_OPEN. Tripping back to OPEN for ${gatewayName} - ${paymentMethod}`, {
        gateway: gatewayName,
        payment_method: paymentMethod,
        trace_id: traceId
      });
      await this.updateState(gatewayName, paymentMethod.toUpperCase(), CircuitState.OPEN, prisma, traceId);
    } else if (state === CircuitState.CLOSED && failures >= FAILURE_THRESHOLD) {
      // Exceeded threshold in CLOSED state: trip to OPEN
      logger.error(`Circuit breaker tripped to OPEN for ${gatewayName} - ${paymentMethod}. Failures: ${failures}`, {
        gateway: gatewayName,
        payment_method: paymentMethod,
        trace_id: traceId
      });
      await this.updateState(gatewayName, paymentMethod.toUpperCase(), CircuitState.OPEN, prisma, traceId);
    }

    // Update rolling metrics in background
    await this.updateHealthMetricsInDB(gatewayName, paymentMethod.toUpperCase(), 0, false, prisma);
  }

  /**
   * Changes state in Redis cache and DB.
   */
  private static async updateState(
    gatewayName: string,
    paymentMethod: string,
    newState: CircuitState,
    prisma: PrismaClient,
    traceId: string
  ): Promise<void> {
    const now = new Date();
    
    // Sync Redis
    await redis.set(`cb:${gatewayName}:${paymentMethod}:state`, newState);
    await redis.set(`cb:${gatewayName}:${paymentMethod}:last_change`, now.toISOString());
    await redis.set(`cb:${gatewayName}:${paymentMethod}:failures`, '0');
    await redis.set(`cb:${gatewayName}:${paymentMethod}:consecutive_successes`, '0');

    // Sync DB
    await prisma.gatewayHealthMetrics.update({
      where: {
        gateway_name_payment_method: {
          gateway_name: gatewayName,
          payment_method: paymentMethod,
        },
      },
      data: {
        state: newState,
        last_state_change: now,
        failure_count: 0,
        success_count: 0,
      },
    });

    logger.info(`Circuit state persisted: ${gatewayName} - ${paymentMethod} is now ${newState}`, {
      gateway: gatewayName,
      payment_method: paymentMethod,
      newState,
      trace_id: traceId
    });
  }

  /**
   * Helper to write state metrics to Redis.
   */
  private static async syncRedis(
    gatewayName: string,
    paymentMethod: string,
    state: CircuitState,
    failures: number,
    successes: number,
    lastChange: Date
  ): Promise<void> {
    const key = `cb:${gatewayName}:${paymentMethod}`;
    await redis.set(`${key}:state`, state);
    await redis.set(`${key}:last_change`, lastChange.toISOString());
    await redis.set(`${key}:failures`, failures.toString());
    await redis.set(`${key}:consecutive_successes`, '0');
  }

  /**
   * Updates success rate and rolling latency on the DB health metrics.
   */
  private static async updateHealthMetricsInDB(
    gatewayName: string,
    paymentMethod: string,
    latencyMs: number,
    isSuccess: boolean,
    prisma: PrismaClient
  ): Promise<void> {
    try {
      const metric = await prisma.gatewayHealthMetrics.findUnique({
        where: {
          gateway_name_payment_method: {
            gateway_name: gatewayName,
            payment_method: paymentMethod,
          },
        },
      });

      if (!metric) return;

      const totalAttempts = metric.success_count + metric.failure_count + 1;
      const successCount = metric.success_count + (isSuccess ? 1 : 0);
      const failureCount = metric.failure_count + (isSuccess ? 0 : 1);
      
      const successRate = successCount / totalAttempts;
      
      let avgLatency = metric.avg_latency_ms;
      if (isSuccess && latencyMs > 0) {
        // Rolling average (weighted 0.9 old, 0.1 new)
        avgLatency = (metric.avg_latency_ms * 0.9) + (latencyMs * 0.1);
      }

      await prisma.gatewayHealthMetrics.update({
        where: {
          id: metric.id,
        },
        data: {
          success_count: successCount,
          failure_count: failureCount,
          success_rate: successRate,
          avg_latency_ms: avgLatency,
        },
      });
    } catch (err) {
      console.error('Error updating DB health metrics:', err);
    }
  }
}
