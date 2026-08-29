import type { Context } from 'hono';
import type { IApiErrorResponse } from '../interfaces/api-response.interface';
import { HttpException } from './http.exception';

export function handleException(err: unknown, c: Context): Response {
  if (err instanceof HttpException) {
    const body: IApiErrorResponse = {
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    };
    return c.json(body, err.statusCode as Parameters<typeof c.json>[1]);
  }

  console.error('[UnhandledError]', err instanceof Error ? err.stack : err);

  const body: IApiErrorResponse = { error: 'An unexpected error occurred.' };
  return c.json(body, 500);
}
