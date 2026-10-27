// Regenerates openapi/openapi.yaml from the real route table. Usage: npm run openapi:generate
import { writeFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { AuthGateway } from '../src/auth/gateway.js';
import { generateOpenApi } from '../src/openapi/generate.js';

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
writeFileSync(
  new URL('../openapi/openapi.yaml', import.meta.url),
  generateOpenApi(app.registeredRoutes),
);
await app.close();
process.stdout.write(`openapi/openapi.yaml written (${app.registeredRoutes.length} routes)\n`);
