import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redisConnectionOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export const redis = new Redis(redisUrl, redisConnectionOptions);

export const redisSubscriber = new Redis(redisUrl, redisConnectionOptions);

redis.on('connect', () => {
  console.log('Redis connected successfully.');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});
