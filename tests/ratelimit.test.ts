import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthGateway } from '../src/auth/gateway.js';
import { createRedis } from '../src/cache/redis.js';

describe('rate limiting without Redis', () => {
  it('an unreachable Redis does not break the API (requests are answered normally)', async () => {
    const redis = createRedis('redis://127.0.0.1:1'); // nothing listens on port 1
    await redis.connect().catch(() => undefined);
    const app = await buildApp({
      environment: 'test',
      version: 'x',
      corsOrigins: [],
      logLevel: 'silent',
      frontendUrl: 'http://localhost',
      pool: {} as unknown as Pool,
      gateway: { verifyToken: async () => null } as unknown as AuthGateway,
      redis,
      checks: {
        database: async () => undefined,
        redis: async () => {
          await redis.ping();
        },
      },
    });
    try {
      const started = Date.now();
      const r = await app.inject({ method: 'GET', url: '/api/v1/academic-levels' });
      expect(r.statusCode).toBe(401); // reached authentication instead of failing with 500
      // ...and at once: requests must not wait for Redis retries (they took ~15s before)
      expect(Date.now() - started).toBeLessThan(1000);
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.json().data.redis).toBe('down');
    } finally {
      await app.close();
      redis.disconnect();
    }
  });
});
