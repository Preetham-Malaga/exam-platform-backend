// PURPOSE: Returns the request ID to the caller in the x-request-id header.
// WHY: Support and logs can trace one request end to end (Fastify generates/reuses the ID).
// DEPENDS ON: Fastify's built-in request.id (configured in app.ts).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a caller-supplied x-request-id only if it is short and safe; otherwise makes a new one. */
export function generateRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}
