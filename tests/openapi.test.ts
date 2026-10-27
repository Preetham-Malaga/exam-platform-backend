import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthGateway } from '../src/auth/gateway.js';
import { generateOpenApi } from '../src/openapi/generate.js';

describe('OpenAPI contract', () => {
  it('openapi/openapi.yaml documents every registered route (run "npm run openapi:generate" after adding routes)', async () => {
    const app = await buildApp({
      environment: 'test',
      version: 'x',
      corsOrigins: [],
      logLevel: 'silent',
      frontendUrl: 'http://localhost',
      pool: {} as unknown as Pool,
      gateway: {} as unknown as AuthGateway,
      checks: { database: async () => undefined, redis: async () => undefined },
    });
    await app.ready();
    const generated = generateOpenApi(app.registeredRoutes);
    const committed = readFileSync(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8');
    expect(committed).toBe(generated);
    expect(
      app.registeredRoutes.filter((r) => r.url.startsWith('/api/v1')).length,
    ).toBeGreaterThanOrEqual(4);
    await app.close();
  });
});
