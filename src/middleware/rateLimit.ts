// PURPOSE: Registers rate limiting (Redis-backed when available so limits hold across several API servers).
// WHY: Protects login/registration from brute force and the API from abuse.
// DEPENDS ON: @fastify/rate-limit, optional ioredis client.

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

export async function registerRateLimit(app: FastifyInstance, redis?: Redis): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(redis ? { redis, nameSpace: 'ratelimit:' } : {}),
    // Redis down must not take the API down (guide 15.1): requests pass unlimited, /health reports Redis as down.
    skipOnError: true,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `tok:${auth.slice(-24)}` : req.ip;
    },
    allowList: (req) => req.url === '/health' || req.url === '/api/v1/health',
  });
}

/** Stricter limit for sensitive endpoints (login, register). */
export const strictRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
