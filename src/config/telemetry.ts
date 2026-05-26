import { Request, Response, NextFunction } from 'express';
import * as promClient from 'prom-client';
import { trace, context } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { logger } from '../utils/logger';

// 1. Prometheus Registry & Metrics Setup
export const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Core counters & gauges
export const httpRequestsCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const requestLatencyHistogram = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0],
  registers: [register],
});

export const paymentSuccessRateGauge = new promClient.Gauge({
  name: 'payment_success_rate',
  help: 'Success rate of payments processed per gateway',
  labelNames: ['gateway'],
  registers: [register],
});

export const dlqDepthGauge = new promClient.Gauge({
  name: 'dlq_depth',
  help: 'Depth of the dead letter queue',
  registers: [register],
});

export const gatewayCircuitGauge = new promClient.Gauge({
  name: 'gateway_circuit_breaker_state',
  help: 'Gateway circuit breaker state (0=OPEN, 0.5=HALF_OPEN, 1=CLOSED)',
  labelNames: ['gateway', 'payment_method'],
  registers: [register],
});

/**
 * Express Middleware to track HTTP request metrics.
 */
export function telemetryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime();
  
  res.on('finish', () => {
    const duration = process.hrtime(start);
    const durationInSeconds = duration[0] + duration[1] / 1e9;
    const route = req.baseUrl + (req.route ? req.route.path : req.path);
    const status = res.statusCode.toString();

    // Increment request count
    httpRequestsCounter.inc({ method: req.method, route, status });
    // Record request latency
    requestLatencyHistogram.observe({ method: req.method, route, status }, durationInSeconds);
  });

  next();
}

// 2. OpenTelemetry Node SDK Initialization
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'payflow-commerce',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
});

export function startTelemetry() {
  sdk.start();
  logger.info('OpenTelemetry SDK initialized and running.');
}

/**
 * Helper to run a synchronous or async block inside an OTel trace span.
 */
export async function runInSpan<T>(spanName: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer('payflow-tracer');
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      span.setAttributes(attributes);
      const result = await fn();
      span.end();
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message }); // 2 = Error status
      span.end();
      throw err;
    }
  });
}
