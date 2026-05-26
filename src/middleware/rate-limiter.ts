import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const LUA_TOKEN_BUCKET = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refill_rate = tonumber(ARGV[2]) -- tokens per second
  local now = tonumber(ARGV[3]) -- Unix timestamp in seconds
  
  local data = redis.call("hmget", key, "tokens", "last_update")
  local last_tokens = tonumber(data[1] or capacity)
  local last_update = tonumber(data[2] or now)
  
  -- Calculate elapsed time and tokens to refill
  local elapsed = math.max(0, now - last_update)
  local tokens = math.min(capacity, last_tokens + (elapsed * refill_rate))
  
  if tokens >= 1 then
    redis.call("hmset", key, "tokens", tokens - 1, "last_update", now)
    return 1
  else
    return 0
  end
`;

export class GatewayRateLimiter {
  // Configurable limits (capacity, tokens-per-second)
  private static limits: Record<string, { capacity: number; refillRate: number }> = {
    razorpay: { capacity: 200, refillRate: 200 },
    stripe: { capacity: 100, refillRate: 100 },
    payu: { capacity: 50, refillRate: 50 },
    upi: { capacity: 150, refillRate: 150 },
  };

  /**
   * Tries to acquire 1 token from the gateway's token bucket in Redis.
   * Returns true if token was acquired, false if rate limit exceeded.
   */
  public static async tryAcquire(gatewayName: string): Promise<boolean> {
    const key = `ratelimit:gateway:${gatewayName.toLowerCase()}`;
    const limit = this.limits[gatewayName.toLowerCase()] || { capacity: 50, refillRate: 50 };
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = await redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        key,
        limit.capacity.toString(),
        limit.refillRate.toString(),
        now.toString()
      );
      return result === 1;
    } catch (err: any) {
      logger.error('Error executing Gateway Rate Limiter Lua Script', { error: err.message, gatewayName });
      // In case Redis fails, fail-open to not block transactions in production
      return true;
    }
  }

  /**
   * Sets custom rate limits for a gateway.
   */
  public static setLimit(gatewayName: string, capacity: number, refillRate: number) {
    this.limits[gatewayName.toLowerCase()] = { capacity, refillRate };
  }
}

/**
 * Express Middleware for Global API Rate Limiting.
 * Limits IP requests to e.g., 20 requests/sec.
 */
export async function apiRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `ratelimit:api:${ip}`;
  const capacity = 20; // Allow burst of 20 requests
  const refillRate = 5; // Refill 5 tokens per second
  const now = Math.floor(Date.now() / 1000);

  try {
    const result = await redis.eval(
      LUA_TOKEN_BUCKET,
      1,
      key,
      capacity.toString(),
      refillRate.toString(),
      now.toString()
    );

    // Set TTL on rate limit keys so they expire
    await redis.expire(key, 60);

    if (result === 1) {
      next();
    } else {
      logger.warn('Global API rate limit exceeded', { ip });
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please retry after some time.',
      });
    }
  } catch (err: any) {
    logger.error('API rate limiter failure', { error: err.message });
    // Fail-open
    next();
  }
}
