// PURPOSE: Shared TypeScript shapes for the API response envelope.
// WHY: Every endpoint must answer with the same { success, data, error, requestId } format.
// DEPENDS ON: Nothing.

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
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

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
