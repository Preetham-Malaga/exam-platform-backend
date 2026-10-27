// PURPOSE: One error type for expected failures + translation of PostgreSQL errors into safe API errors.
// WHY: Users must never see SQL, constraint names or stack traces; they get a stable code and a friendly message.
// DEPENDS ON: Nothing. Used by errorHandler, services and middleware.

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

/** Messages for the error tokens raised by our SQL functions/triggers (errcode EXnnn). */
const FRIENDLY: Record<string, string> = {
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  NOT_A_STUDENT: 'Your account is not registered as an active student in this organization.',
  EXAM_NOT_AVAILABLE: 'This exam is not available to you right now.',
  MAX_ATTEMPTS_REACHED: 'You have used all attempts for this exam.',
  EXAM_HAS_NO_QUESTIONS: 'This exam has no questions.',
  ATTEMPT_NOT_FOUND: 'Attempt not found.',
  ATTEMPT_CLOSED: 'This attempt has already been submitted.',
  ATTEMPT_OPEN: 'Submit the attempt before viewing its result.',
  DEADLINE_PASSED: 'The time for this exam is over.',
  QUESTION_NOT_IN_ATTEMPT: 'That question is not part of this attempt.',
  INVALID_OPTION: 'That option does not belong to the question.',
  RESULTS_HIDDEN: 'Results for this exam are not available.',
  EXAM_INCOMPLETE: 'Add settings and at least one question before publishing the exam.',
  QUESTION_INCOMPLETE:
    'A question needs at least two options and a correct answer before it can be published.',
  QUESTION_NOT_PUBLISHED: 'Only published questions can be added to an exam.',
  EXAM_HAS_ATTEMPTS: 'This exam already has attempts, so its questions can no longer change.',
  PLAN_LIMIT_REACHED: 'Your plan limit has been reached. Please upgrade your plan.',
  SUBSCRIPTION_INACTIVE: 'Your subscription is not active.',
  INVALID_ASSIGNMENT_TARGET: 'The assignment target does not belong to your organization.',
  INVALID_SCOPE_TARGET: 'The scope target does not belong to your organization.',
  INVALID_ROLE: 'That role cannot be assigned.',
  INVALID_PARENT_UNIT: 'The parent unit does not exist in your organization.',
  INVALID_UNIT_LEVEL:
    'A unit must sit on a lower level than its parent (for example Branch under Program).',
  BAD_REQUEST: 'The request is invalid.',
  AUDIT_LOG_IMMUTABLE: 'Audit logs cannot be changed.',
  ORGANIZATION_CHANGE_FORBIDDEN: 'This change is not allowed.',
};

const EX_STATUS: Record<string, number> = {
  EX400: 400,
  EX401: 401,
  EX402: 402,
  EX403: 403,
  EX404: 404,
  EX409: 409,
  EX410: 410,
  EX422: 422,
};

interface PgLikeError {
  code?: string;
  message?: string;
  detail?: string;
}

/** Returns an AppError for known database failures, or null when the error is unexpected (=> 500). */
export function fromDatabaseError(err: unknown): AppError | null {
  const e = err as PgLikeError;
  if (!e || typeof e.code !== 'string') return null;
  const status = EX_STATUS[e.code];
  if (status) {
    const token = (e.message ?? '').trim();
    const known = FRIENDLY[token];
    return new AppError(
      status,
      known ? token : 'REQUEST_FAILED',
      known ?? 'The request could not be completed.',
    );
  }
  switch (e.code) {
    case '42501':
      return new AppError(403, 'FORBIDDEN', FRIENDLY.FORBIDDEN!);
    case '23505':
      return new AppError(409, 'DUPLICATE', 'A record with the same code or name already exists.');
    case '23503':
      return new AppError(
        409,
        'REFERENCE_CONFLICT',
        'This record is linked to other data and cannot be changed that way.',
      );
    case '23514':
    case '22P02':
    case '22001':
    case '22003':
    case '23502':
    case '22007':
    case '22008':
      return new AppError(400, 'BAD_REQUEST', 'Some of the submitted data is invalid.');
    default:
      return null;
  }
}
