/**
 * Next.js route-handler adapter using only Web Request/Response (no `next` import).
 * Route handlers: https://nextjs.org/docs/app/building-your-application/routing/route-handlers
 */
import { PlatformError } from './errors';
import { bearerToken, errorResponse } from './http';
import type { PermissionRequirement, PlatformServer } from './platform-server';
import type { AccessTokenClaims } from './tokens';

/** Options of {@link withPlatformToken}. */
export interface WithPlatformTokenOptions {
  server: PlatformServer;
  audience?: string | string[];
  permission?: PermissionRequirement;
}

/** Context passed to the wrapped handler: the route context plus verified claims. */
export type PlatformHandlerContext<C> = C & { claims: AccessTokenClaims };

/** Wrap a route handler so it runs only with a valid platform access token (claims in the second argument). */
export function withPlatformToken<C extends object = Record<string, never>>(
  handler: (req: Request, ctx: PlatformHandlerContext<C>) => Response | Promise<Response>,
  o: WithPlatformTokenOptions,
): (req: Request, ctx?: C) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = req.headers.get('x-request-id') ?? globalThis.crypto.randomUUID();
    const token = bearerToken(req.headers.get('authorization'));
    if (!token)
      return errorResponse(new PlatformError('unauthenticated', 'missing bearer token'), requestId);
    let claims: AccessTokenClaims;
    try {
      claims = await o.server.verifyAccessToken(token, {
        audience: o.audience,
        permission: o.permission,
      });
    } catch (e) {
      return errorResponse(e, requestId);
    }
    return handler(req, { ...(ctx ?? ({} as C)), claims });
  };
}
