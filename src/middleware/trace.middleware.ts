import { Request, Response, NextFunction } from 'express';
import { traceStore } from '../utils/logger';
import * as crypto from 'crypto';

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] || req.headers['x-correlation-id'] || crypto.randomUUID()) as string;
  res.setHeader('X-Trace-ID', traceId);

  const store = new Map<string, string>();
  store.set('trace_id', traceId);

  if (req.params && req.params.id) {
    store.set('transaction_id', req.params.id);
  }

  traceStore.run(store, () => {
    next();
  });
}
