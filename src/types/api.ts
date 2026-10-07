// PURPOSE: Shared TypeScript shapes for the API response envelope.
// WHY: Every endpoint must answer with the same { success, data, error, requestId } format.
// DEPENDS ON: Nothing. Used by utils/response.ts, middleware/errorHandler.ts and every controller.

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: ApiError;
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
