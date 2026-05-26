import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

// Thread-local context storage for distributed tracing
export const traceStore = new AsyncLocalStorage<Map<string, string>>();

// Base logger configuration
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const logger = {
  info: (msg: string, metadata?: Record<string, any>) => log('info', msg, metadata),
  warn: (msg: string, metadata?: Record<string, any>) => log('warn', msg, metadata),
  error: (msg: string, metadata?: Record<string, any>) => log('error', msg, metadata),
  debug: (msg: string, metadata?: Record<string, any>) => log('debug', msg, metadata),
};

function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string, metadata?: Record<string, any>) {
  const store = traceStore.getStore();
  const traceId = store?.get('trace_id');
  const transactionId = store?.get('transaction_id');
  const gateway = store?.get('gateway');
  const action = store?.get('action');

  const mergedMetadata = {
    trace_id: traceId || metadata?.trace_id,
    transaction_id: transactionId || metadata?.transaction_id,
    gateway: gateway || metadata?.gateway,
    action: action || metadata?.action,
    service_name: 'payflow_commerce',
    ...metadata,
  };

  if (level === 'info') {
    baseLogger.info(mergedMetadata, msg);
  } else if (level === 'warn') {
    baseLogger.warn(mergedMetadata, msg);
  } else if (level === 'error') {
    baseLogger.error(mergedMetadata, msg);
  } else if (level === 'debug') {
    baseLogger.debug(mergedMetadata, msg);
  }
}

/**
 * Dynamically updates the current asynchronous context store.
 */
export function setLogContext(key: string, value: string) {
  const store = traceStore.getStore();
  if (store) {
    store.set(key, value);
  }
}
