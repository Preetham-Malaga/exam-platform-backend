// PURPOSE: Builds the Fastify application (plugins, hooks, routes) without starting a server.
// WHY: Separating construction from listening lets tests call app.inject() with fake dependencies.
// DEPENDS ON: middleware/*, health/*. Used by server.ts and tests.

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health/health.routes.js';
import type { HealthChecks } from './health/health.service.js';
import { registerErrorHandling } from './middleware/errorHandler.js';
import { generateRequestId, registerRequestId } from './middleware/requestId.js';

export interface AppOptions {
  environment: string;
  version: string;
  corsOrigins: string[];
  logLevel: string;
  checks: HealthChecks;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: (req) => generateRequestId(req.headers['x-request-id']),
    trustProxy: true,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: options.corsOrigins,
    credentials: true,
  });

  registerRequestId(app);
  registerErrorHandling(app);
  registerHealthRoutes(app, {
    checks: options.checks,
    version: options.version,
    environment: options.environment,
  });

  return app;
}
