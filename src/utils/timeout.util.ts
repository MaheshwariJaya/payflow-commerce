import { logger } from './logger';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps a promise factory in a timeout limit.
 * Passes an AbortSignal to the factory, allowing the inner HTTP client to cancel the request upon timeout.
 */
export async function withTimeout<T>(
  promiseFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = 2000,
  context: string = 'Gateway Call'
): Promise<T> {
  const controller = new AbortController();
  const signal = controller.signal;

  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${context} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      promiseFactory(signal),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
