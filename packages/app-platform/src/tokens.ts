import { z } from 'zod';
import { AccountRefSchema } from './installation';
import { PermissionsSchema } from './permissions';

/** Max lifetime of an app JWT (seconds), as GitHub Apps. */
export const APP_JWT_MAX_LIFETIME_SEC = 600;
/** Max lifetime of an installation / user-to-server access token (seconds). */
export const ACCESS_TOKEN_MAX_LIFETIME_SEC = 3600;
/** Lifetime of a UI-extension session token (seconds). */
export const SESSION_TOKEN_LIFETIME_SEC = 60;
/** JOSE `typ` header of RFC 9068 access tokens. */
export const ACCESS_TOKEN_TYP = 'at+jwt';
/** JOSE `typ` header of UI session tokens. */
export const SESSION_TOKEN_TYP = 'codai-session+jwt';

const NumericDate = z.number().int().nonnegative();
const Audience = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Claims of the short-lived JWT an app signs with its private key to call `/app/*`. */
export const AppJwtClaimsSchema = z
  .object({
    iss: z.string().min(1),
    iat: NumericDate,
    exp: NumericDate,
    aud: Audience,
    jti: z.string().optional(),
  })
  .refine((c) => c.exp > c.iat, { message: 'exp must be after iat', path: ['exp'] })
  .refine((c) => c.exp - c.iat <= APP_JWT_MAX_LIFETIME_SEC, {
    message: 'app JWT lifetime exceeds 600 s',
    path: ['exp'],
  });
export type AppJwtClaims = z.infer<typeof AppJwtClaimsSchema>;

/** Installation context embedded in access tokens. */
export const InstallationClaimSchema = z.object({
  id: z.string().min(1),
  account: AccountRefSchema,
  permissions: PermissionsSchema,
  project_ids: z.array(z.string()).optional(),
});

const AccessTokenBase = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: Audience,
  client_id: z.string().min(1),
  iat: NumericDate,
  exp: NumericDate,
  jti: z.string().min(1),
  scope: z.string(),
  codai_installation: InstallationClaimSchema,
});

const lifetime = <T extends { iat: number; exp: number }>(c: T) =>
  c.exp > c.iat && c.exp - c.iat <= ACCESS_TOKEN_MAX_LIFETIME_SEC;

/** RFC 9068 claims of an installation access token (`sub = installation:<id>`). */
export const InstallationTokenClaimsSchema = AccessTokenBase.extend({
  sub: z.string().regex(/^installation:.+$/),
}).refine(lifetime, { message: 'access token lifetime must be in (0, 3600] s', path: ['exp'] });
export type InstallationTokenClaims = z.infer<typeof InstallationTokenClaimsSchema>;

/** RFC 8693 §4.1 actor claim (may nest). */
export interface ActorClaim {
  sub: string;
  iss?: string | undefined;
  act?: ActorClaim | undefined;
}
/** Zod schema for {@link ActorClaim}. */
export const ActorClaimSchema: z.ZodType<ActorClaim> = z.lazy(() =>
  z.object({
    sub: z.string().min(1),
    iss: z.string().optional(),
    act: ActorClaimSchema.optional(),
  }),
);

/** Claims of a user-to-server token: acts for `sub` (a user) inside an installation, permissions = intersection. */
export const UserToServerClaimsSchema = AccessTokenBase.extend({
  sub: z.string().regex(/^user:.+$/),
  act: ActorClaimSchema.optional(),
}).refine(lifetime, { message: 'access token lifetime must be in (0, 3600] s', path: ['exp'] });
export type UserToServerClaims = z.infer<typeof UserToServerClaimsSchema>;

/** Any verified access token. */
export type AccessTokenClaims = InstallationTokenClaims | UserToServerClaims;

/** Claims of the ≈60 s session token the host hands to a UI extension iframe. */
export const SessionTokenClaimsSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().regex(/^user:.+$/),
    aud: z.string().min(1),
    dest: z.string().min(1),
    iat: NumericDate,
    nbf: NumericDate.optional(),
    exp: NumericDate,
    jti: z.string().min(1),
    installation_id: z.string().min(1),
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= 2 * SESSION_TOKEN_LIFETIME_SEC, {
    message: 'session token lifetime too long',
    path: ['exp'],
  });
export type SessionTokenClaims = z.infer<typeof SessionTokenClaimsSchema>;
