import { redis } from '../config/redis';
import * as crypto from 'crypto';

const RELEASE_LUA_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export class LockUtil {
  public static async acquireRedisLock(key: string, ttlMs: number = 5000): Promise<string | null> {
    const token = crypto.randomUUID();
    const redisKey = `lock:${key}`;

    const result = await redis.set(redisKey, token, 'PX', ttlMs, 'NX');

    if (result === 'OK') {
      return token;
    }
    return null;
  }

  public static async releaseRedisLock(key: string, token: string): Promise<boolean> {
    const redisKey = `lock:${key}`;
    const result = await redis.eval(RELEASE_LUA_SCRIPT, 1, redisKey, token);
    return result === 1;
  }

  public static async acquirePostgresAdvisoryLock(prisma: any, key: string): Promise<void> {
    const hash = crypto.createHash('sha256').update(key).digest();

    const lockId = hash.readBigInt64BE(0);

    await prisma.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, lockId);
  }
}
