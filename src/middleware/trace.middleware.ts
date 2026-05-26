import { Request, Response, NextFunction } from 'express';
import { traceStore } from '../utils/logger';
import * as crypto from 'crypto';

/**
 * Middleware to trace requests through AsyncLocalStorage.
 * Pulls or generates a trace ID and sets it in the request context and response headers.
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] || req.headers['x-correlation-id'] || crypto.randomUUID()) as string;
  res.setHeader('X-Trace-ID', traceId);

  // Initialize store map
  const store = new Map<string, string>();
  store.set('trace_id', traceId);

  // Check if standard REST URL contains transactional identifier
  if (req.params && req.params.id) {
    store.set('transaction_id', req.params.id);
  }

  traceStore.run(store, () => {
    next();
  });
}
