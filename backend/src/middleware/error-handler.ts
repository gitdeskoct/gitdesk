import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { logEvent } from '../lib/log';

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, requestId } },
      err.status,
    );
  }
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request was rejected.',
          requestId,
        },
      },
      err.status,
    );
  }
  logEvent(
    'unhandled_error',
    { requestId, path: c.req.path, error: err.name },
    'error',
  );
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side.',
        requestId,
      },
    },
    500,
  );
};

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Not found.',
        requestId: c.get('requestId'),
      },
    },
    404,
  );
