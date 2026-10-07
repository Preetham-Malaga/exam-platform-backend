// PURPOSE: Builds the standard success/failure response envelope.
// WHY: One place guarantees all endpoints return the same JSON structure.
// DEPENDS ON: types/api.ts. Used by controllers, health routes and the error handler.

import type { ApiFailure, ApiSuccess } from '../types/api.js';

export function ok<T>(data: T, requestId: string): ApiSuccess<T> {
  return { success: true, data, error: null, requestId };
}

export function fail(code: string, message: string, requestId: string): ApiFailure {
  return { success: false, data: null, error: { code, message }, requestId };
}
