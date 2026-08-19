import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Every error the API returns has the same shape:
// { error: { code, message, details? } }

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFoundError = (entity: string, id: string) =>
  new ApiError(404, 'not_found', `${entity} '${id}' not found`);

export const conflictError = (code: string, message: string) =>
  new ApiError(409, code, message);

export function errorBody(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    return c.json(errorBody('http_error', err.message), err.status);
  }
  console.error('Unhandled error:', err);
  return c.json(errorBody('internal_error', 'Internal server error'), 500);
}
