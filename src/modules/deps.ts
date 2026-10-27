// PURPOSE: The dependencies every module receives (database pool, auth gateway, authenticate guard, URLs).
// WHY: Explicit dependency passing keeps modules testable and avoids hidden globals.
// DEPENDS ON: pg, auth/gateway.ts.

import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthGateway } from '../auth/gateway.js';

export interface Deps {
  pool: Pool;
  gateway: AuthGateway;
  authenticate: (request: FastifyRequest) => Promise<void>;
  frontendUrl: string;
}

export const API = '/api/v1';
