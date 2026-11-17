import { z } from 'zod';

/** RFC 8693 grant type. */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** RFC 7523 client assertion type. */
export const JWT_BEARER_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const IETF_TT = 'urn:ietf:params:oauth:token-type:';
const CODAI_TT = 'urn:codai:params:oauth:token-type:';

/** Token type URIs used by the platform (RFC 8693 §3 plus platform-specific ones). */
export const TOKEN_TYPES = {
  access: `${IETF_TT}access_token`,
  jwt: `${IETF_TT}jwt`,
  id: `${IETF_TT}id_token`,
  session: `${CODAI_TT}session_token`,
  app: `${CODAI_TT}app_jwt`,
} as const;

/** Any token type URI. */
export const TokenTypeSchema = z.string().regex(/^urn:[a-z0-9:._-]+$/i);

const Resource = z.union([z.url(), z.array(z.url()).min(1)]);

/** RFC 8693 §2.1 token-exchange request (form fields). */
export const TokenExchangeRequestSchema = z
  .object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT),
    subject_token: z.string().min(1),
    subject_token_type: TokenTypeSchema,
    actor_token: z.string().min(1).optional(),
    actor_token_type: TokenTypeSchema.optional(),
    requested_token_type: TokenTypeSchema.default(TOKEN_TYPES.access),
    resource: Resource.optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    scope: z.string().optional(),
    client_id: z.string().optional(),
    client_assertion_type: z.literal(JWT_BEARER_ASSERTION).optional(),
    client_assertion: z.string().optional(),
    /** Platform extension: target installation for cross-platform delegation. */
    installation_id: z.string().min(1).optional(),
  })
  .refine((r) => (r.actor_token === undefined) === (r.actor_token_type === undefined), {
    message: 'actor_token and actor_token_type go together',
    path: ['actor_token_type'],
  });
export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequestSchema>;

/** RFC 8693 §2.2.1 token-exchange response. */
export const TokenExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: TokenTypeSchema,
  token_type: z.enum(['Bearer', 'N_A']),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
});
export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponseSchema>;

/** RFC 6749 §4.4 client_credentials request authenticated with an RFC 7523 JWT assertion. */
export const ClientCredentialsRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_assertion_type: z.literal(JWT_BEARER_ASSERTION),
  client_assertion: z.string().min(1),
  scope: z.string().optional(),
  resource: Resource.optional(),
  audience: z.string().optional(),
  installation_id: z.string().optional(),
});
export type ClientCredentialsRequest = z.infer<typeof ClientCredentialsRequestSchema>;

/** RFC 6749 §5.2 + RFC 8693 §2.2.2 error codes. */
export const OAuthErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
]);
export type OAuthErrorCode = z.infer<typeof OAuthErrorCodeSchema>;

/** RFC 6749 §5.2 error response. */
export const OAuthErrorResponseSchema = z.object({
  error: OAuthErrorCodeSchema,
  error_description: z.string().optional(),
  error_uri: z.url().optional(),
});
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>;

/** Token endpoint request: token exchange or client credentials. */
export const TokenRequestSchema = z.union([
  TokenExchangeRequestSchema,
  ClientCredentialsRequestSchema,
]);
export type TokenRequest = z.infer<typeof TokenRequestSchema>;
