import type { ContentfulStatusCode } from 'hono/utils/http-status';

const STATUS = {
  AUTH_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  INVALID_GRANT: 400,
  AUTH_PROVIDER_ERROR: 502,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  NAME_TAKEN: 409,
  INVALID_STATE: 409,
  LIMIT_REACHED: 403,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  GIT_HOST_ERROR: 502,
  GIT_HOSTING_UNAVAILABLE: 503,
} satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof STATUS;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): ContentfulStatusCode {
    return STATUS[this.code];
  }
}
