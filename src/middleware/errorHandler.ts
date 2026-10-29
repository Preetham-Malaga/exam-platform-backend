// PURPOSE: Converts every error and unknown route into the standard failure envelope.
// WHY: Users must never see stack traces, SQL or secrets; details are logged server-side only.
// DEPENDS ON: utils/response.ts, utils/errors.ts.

import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, fromDatabaseError } from '../utils/errors.js';
import { fail } from '../utils/response.js';

const FRIENDLY: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request is invalid.' },
  401: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' },
  403: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' },
  404: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
};

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply
        .code(400)
        .send(
          fail(
            'VALIDATION_ERROR',
            'Please correct the highlighted fields.',
            request.id,
            details,
            details[0]?.path || undefined,
          ),
        );
    }
    const known = error instanceof AppError ? error : fromDatabaseError(error);
    if (known) {
      request.log.warn({ code: known.code, status: known.status }, 'request rejected');
      return reply
        .code(known.status)
        .send(fail(known.code, known.message, request.id, known.details, known.field));
    }

    const fastifyStatus = (error as FastifyError).statusCode;
    const status = typeof fastifyStatus === 'number' && fastifyStatus >= 400 ? fastifyStatus : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    else request.log.warn({ code: (error as FastifyError).code, status }, 'request rejected');

    const friendly = FRIENDLY[status] ?? {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
      message:
        status >= 500 ? 'Something went wrong on our side. Please try again.' : 'Request failed.',
    };
    return reply.code(status).send(fail(friendly.code, friendly.message, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const { code, message } = FRIENDLY[404]!;
    return reply.code(404).send(fail(code, message, request.id));
  });
}
