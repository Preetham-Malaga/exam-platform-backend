// PURPOSE: Builds the Fastify application (plugins, hooks, routes) without starting a server.
// WHY: Separating construction from listening lets tests call app.inject() with fake dependencies.
// DEPENDS ON: middleware/*, health/*, modules/*. Used by server.ts and tests.

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { AuthGateway } from './auth/gateway.js';
import { registerHealthRoutes } from './health/health.routes.js';
import type { HealthChecks } from './health/health.service.js';
import { authenticate } from './middleware/auth.js';
import { registerErrorHandling } from './middleware/errorHandler.js';
import { registerRateLimit } from './middleware/rateLimit.js';
import { generateRequestId, registerRequestId } from './middleware/requestId.js';
import type { Deps } from './modules/deps.js';
import { registerAcademicCatalogRoutes } from './modules/academic/catalog.routes.js';
import { registerAcademicStructureRoutes } from './modules/academic/structure.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { registerOrganizationRoutes } from './modules/organizations/organizations.routes.js';
import { registerAttemptRoutes } from './modules/attempts/attempts.routes.js';
import { registerExamRoutes } from './modules/exams/exams.routes.js';
import { registerQuestionRoutes } from './modules/questions/questions.routes.js';
import { registerInsightRoutes } from './modules/results/insights.routes.js';
import { registerStudentRoutes } from './modules/students/students.routes.js';
import { registerTeacherRoutes } from './modules/teachers/teachers.routes.js';
import type { RequestContext } from './types/context.js';

export interface AppOptions {
  environment: string;
  version: string;
  corsOrigins: string[];
  logLevel: string;
  checks: HealthChecks;
  pool: Pool;
  gateway: AuthGateway;
  frontendUrl: string;
  redis?: Redis;
}

const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Browser origins that may call the API: exactly CORS_ORIGINS, plus (development only) the frontend on any local port,
 * so a dev server that moved from 5173 to 5174 does not silently break sign-in.
 */
export function allowedOrigin(list: string[], environment: string) {
  return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) =>
    cb(
      null,
      origin === undefined ||
        list.includes(origin) ||
        (environment === 'development' && LOCAL_DEV_ORIGIN.test(origin)),
    );
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: (req) => generateRequestId(req.headers['x-request-id']),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet);
  await registerRateLimit(app, options.redis);
  await app.register(cors, {
    origin: allowedOrigin(options.corsOrigins, options.environment),
    credentials: true,
    // @fastify/cors only allows GET/HEAD/POST by default: browsers would block every edit and delete.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  app.decorateRequest('ctx', undefined as unknown as RequestContext);
  // Keep a list of registered routes: used by the OpenAPI contract test/generator.
  const routeList: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (r) => {
    for (const m of ([] as string[]).concat(r.method))
      if (m !== 'HEAD' && m !== 'OPTIONS') routeList.push({ method: m, url: r.url });
  });
  app.decorate('registeredRoutes', routeList);
  registerRequestId(app);
  registerErrorHandling(app);
  registerHealthRoutes(app, {
    checks: options.checks,
    version: options.version,
    environment: options.environment,
  });

  const deps: Deps = {
    pool: options.pool,
    gateway: options.gateway,
    authenticate: authenticate(options.pool, options.gateway),
    frontendUrl: options.frontendUrl,
  };
  registerAuthRoutes(app, deps);
  registerOrganizationRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerAcademicStructureRoutes(app, deps);
  registerAcademicCatalogRoutes(app, deps);
  registerTeacherRoutes(app, deps);
  registerStudentRoutes(app, deps);
  registerQuestionRoutes(app, deps);
  registerExamRoutes(app, deps);
  registerAttemptRoutes(app, deps);
  registerInsightRoutes(app, deps);

  return app;
}
