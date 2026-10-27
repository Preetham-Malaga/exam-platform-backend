import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { AuthGateway } from '../src/auth/gateway.js';

const base = {
  environment: 'test',
  version: '0.1.0',
  corsOrigins: ['http://localhost:5173'],
  logLevel: 'silent',
  frontendUrl: 'http://localhost:5173',
  pool: {} as unknown as Pool,
  gateway: {} as unknown as AuthGateway,
};
const up = async () => undefined;
const down = async () => {
  throw new Error('connection refused: postgres://user:secret@host/db');
};

describe('GET /health', () => {
  it('returns 200 and the envelope when all dependencies are up', async () => {
    const app = await buildApp({ ...base, checks: { database: up, redis: up } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    expect(body.data).toEqual({
      status: 'ok',
      api: 'up',
      database: 'up',
      redis: 'up',
      version: '0.1.0',
      environment: 'test',
    });
    expect(body.requestId).toBe(res.headers['x-request-id']);
    await app.close();
  });

  it('serves the versioned path too', async () => {
    const app = await buildApp({ ...base, checks: { database: up, redis: up } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 503 and hides error details when a dependency is down', async () => {
    const app = await buildApp({ ...base, checks: { database: down, redis: up } });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().data.database).toBe('down');
    expect(res.body).not.toContain('secret');
    await app.close();
  });

  it('reuses a safe incoming x-request-id and replaces an unsafe one', async () => {
    const app = await buildApp({ ...base, checks: { database: up, redis: up } });
    const good = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-abc12345' },
    });
    expect(good.headers['x-request-id']).toBe('trace-abc12345');
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id with spaces <script>' },
    });
    expect(bad.headers['x-request-id']).not.toContain('script');
    await app.close();
  });
});

describe('unknown routes', () => {
  it('return the standard failure envelope', async () => {
    const app = await buildApp({ ...base, checks: { database: up, redis: up } });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'NOT_FOUND' },
    });
    await app.close();
  });
});
