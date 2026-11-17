import { z } from 'zod';

/** Machine-readable platform error codes with their HTTP status. */
export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 422,
  unsupported_revision: 400,
  unauthenticated: 401,
  invalid_token: 401,
  token_expired: 401,
  token_revoked: 401,
  forbidden: 403,
  insufficient_permissions: 403,
  permissions_exceeded: 422,
  projects_exceeded: 422,
  installation_suspended: 403,
  installation_inactive: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
} as const;

/** Platform error code. */
export type PlatformErrorCode = keyof typeof ERROR_STATUS;

/** Zod enum of {@link PlatformErrorCode}. */
export const PlatformErrorCodeSchema = z.enum(
  Object.keys(ERROR_STATUS) as [PlatformErrorCode, ...PlatformErrorCode[]],
);

/** Error envelope returned by every REST route on failure. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    request_id: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Typed platform error that maps to an HTTP status and envelope. */
export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: PlatformErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  /** Serialise as an {@link ErrorEnvelope}. */
  toEnvelope(requestId?: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { request_id: requestId } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Type guard for {@link PlatformError}. */
export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError;
}

/** Build an error envelope object. */
export function errorEnvelope(code: string, message: string, requestId?: string): ErrorEnvelope {
  return { error: { code, message, ...(requestId ? { request_id: requestId } : {}) } };
}

/** RFC 6749 §5.2 error raised by the token endpoint. */
export class OAuthError extends Error {
  readonly error:
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope'
    | 'invalid_target';
  readonly status: number;

  constructor(error: OAuthError['error'], description: string) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = error === 'invalid_client' ? 401 : 400;
  }

  /** Serialise as an RFC 6749 §5.2 body. */
  toJSON(): { error: OAuthError['error']; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}
