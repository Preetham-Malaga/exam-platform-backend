// PURPOSE: Registers GET /health and GET /api/v1/health.
// WHY: /health is for load balancers; /api/v1/health follows the versioned API contract.
// DEPENDS ON: health.service.ts, utils/response.ts.

import type { FastifyInstance } from 'fastify';
import { ok } from '../utils/response.js';
import { buildHealthReport, type HealthChecks } from './health.service.js';

export interface HealthRouteOptions {
  checks: HealthChecks;
  version: string;
  environment: string;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const handler = async (request: { id: string }, reply: { code: (n: number) => unknown }) => {
    const report = await buildHealthReport(options.checks, {
      version: options.version,
      environment: options.environment,
    });
    reply.code(report.status === 'ok' ? 200 : 503);
    return ok(report, request.id);
  };

  app.get('/health', handler);
  app.get('/api/v1/health', handler);
}
