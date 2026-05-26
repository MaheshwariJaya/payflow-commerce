import { redis } from '../config/redis';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const RELEASE_LUA_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export class LockUtil {
  /**
   * Acquires a Redis distributed lock.
   * @returns The lock token if successful, or null if lock is already held.
   */
  public static async acquireRedisLock(key: string, ttlMs: number = 5000): Promise<string | null> {
    const token = crypto.randomUUID();
    const redisKey = `lock:${key}`;
    
    // NX: Set only if key does not exist
    // PX: Set expire time in milliseconds
    const result = await redis.set(redisKey, token, 'PX', ttlMs, 'NX');
    
    if (result === 'OK') {
      return token;
    }
    return null;
  }

  /**
   * Releases a Redis distributed lock safely using a Lua script to verify token ownership.
   */
  public static async releaseRedisLock(key: string, token: string): Promise<boolean> {
    const redisKey = `lock:${key}`;
    const result = await redis.eval(RELEASE_LUA_SCRIPT, 1, redisKey, token);
    return result === 1;
  }

  /**
   * Acquires a transaction-level PostgreSQL session/transaction advisory lock.
   * This lock is automatically released when the transaction ends (commit or rollback).
   * Generates a 64-bit integer hash from the string key.
   */
  public static async acquirePostgresAdvisoryLock(prisma: any, key: string): Promise<void> {
    // Generate a bigint hash from the key string
    const hash = crypto.createHash('sha256').update(key).digest();
    // Read the first 8 bytes as a 64-bit integer (signed bigint)
    const lockId = hash.readBigInt64BE(0);
    
    // Acquire a transaction-level exclusive advisory lock
    // pg_advisory_xact_lock blocks until lock is available
    await prisma.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1)`,
      lockId
    );
  }
}
