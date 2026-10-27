import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthGateway } from '../src/auth/gateway.js';

const app = (environment: string) =>
  buildApp({
    environment,
    version: 'x',
    corsOrigins: ['https://app.example.com'],
    logLevel: 'silent',
    frontendUrl: 'https://app.example.com',
    pool: {} as unknown as Pool,
    gateway: {} as unknown as AuthGateway,
    checks: { database: async () => undefined, redis: async () => undefined },
  });

const preflight = async (environment: string, origin: string, method: string) => {
  const a = await app(environment);
  try {
    const r = await a.inject({
      method: 'OPTIONS',
      url: '/api/v1/students/x',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    return {
      allowOrigin: r.headers['access-control-allow-origin'],
      methods: String(r.headers['access-control-allow-methods'] ?? ''),
    };
  } finally {
    await a.close();
  }
};

describe('CORS (browser access to the API)', () => {
  it('the configured frontend may use every method the API has (edits and deletes included)', async () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await preflight('production', 'https://app.example.com', m);
      expect(r.allowOrigin, m).toBe('https://app.example.com');
      expect(
        r.methods.split(',').map((x) => x.trim()),
        m,
      ).toContain(m);
    }
  });

  it('other origins are never allowed outside development', async () => {
    for (const env of ['production', 'staging', 'test'])
      for (const o of ['https://evil.example', 'http://localhost:5174'])
        expect((await preflight(env, o, 'GET')).allowOrigin, `${env} ${o}`).toBeUndefined();
  });

  it('in development the frontend may run on any local port (5173 busy -> 5174)', async () => {
    for (const o of ['http://localhost:5174', 'http://127.0.0.1:5173'])
      expect((await preflight('development', o, 'PATCH')).allowOrigin, o).toBe(o);
    for (const o of ['https://evil.example', 'http://localhost.evil.example:5173'])
      expect((await preflight('development', o, 'GET')).allowOrigin, o).toBeUndefined();
  });
});
