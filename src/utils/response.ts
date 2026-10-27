// PURPOSE: Builds the standard success/failure response envelope.
// WHY: One place guarantees all endpoints return the same JSON structure.
// DEPENDS ON: types/api.ts.

import type { ApiFailure, ApiSuccess } from '../types/api.js';

export function ok<T>(data: T, requestId: string): ApiSuccess<T> {
  return { success: true, data, error: null, requestId };
}

export function fail(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ApiFailure {
  return {
    success: false,
    data: null,
    error: details === undefined ? { code, message } : { code, message, details },
    requestId,
  };
}
