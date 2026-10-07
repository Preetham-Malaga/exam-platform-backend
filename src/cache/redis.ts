// PURPOSE: Creates the shared Redis client.
// WHY: Redis backs rate limits, caches and queues in later phases.
// DEPENDS ON: REDIS_URL, the ioredis package. Used by server.ts and health checks.

import { Redis } from 'ioredis';

export function createRedis(url: string, onError?: (err: Error) => void): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
  // Without a listener ioredis prints every connection error; /health reports the outage instead.
  client.on('error', (err) => onError?.(err));
  return client;
}
