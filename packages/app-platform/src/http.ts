import { errorEnvelope, OAuthError, PlatformError } from './errors';
import { PLATFORM_REVISION, REVISION_HEADER } from './version';

/** Extract a Bearer token from an Authorization header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

/** Status + JSON body for any thrown error (PlatformError, OAuthError, or unknown → 500). */
export function errorToBody(e: unknown, requestId?: string): { status: number; body: unknown } {
  if (e instanceof PlatformError) return { status: e.status, body: e.toEnvelope(requestId) };
  if (e instanceof OAuthError) return { status: e.status, body: e.toJSON() };
  return { status: 500, body: errorEnvelope('internal', 'internal error', requestId) };
}

/** JSON Response with the revision header echoed. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [REVISION_HEADER]: PLATFORM_REVISION,
      ...extra,
    },
  });
}

/** Error Response for any thrown error. */
export function errorResponse(e: unknown, requestId?: string): Response {
  const { status, body } = errorToBody(e, requestId);
  const extra: Record<string, string> = requestId ? { 'x-request-id': requestId } : {};
  if (status === 401) extra['www-authenticate'] = 'Bearer realm="codai-platform"';
  return jsonResponse(body, status, extra);
}
