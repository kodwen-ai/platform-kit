/**
 * "Link account" contract between two platforms (ADR 2026-10-19-platform-fabric D11):
 * linking = installing the peer's app on the receiving platform, with consent.
 *
 *   1. The ORIGIN platform (e.g. Brivio) signs a short-lived link assertion with its OIDC key
 *      (`typ: codai-link+jwt`, `aud` = receiving platform issuer, ≤ 5 min) carrying the verified
 *      identity of its user (verified email, optional org with tax id).
 *   2. It redirects the browser to the receiver's install URL
 *      (`<hub>/apps/<slug>/install?state=…&link_assertion=…`).
 *   3. The receiver verifies the assertion against a TRUSTED issuer (its own registry), lets the
 *      user sign in or create an account just-in-time (separate ToS acceptance — two operators),
 *      shows the consent screen, creates the installation and records the federated link.
 *   4. It redirects to the app's `setup_url` with `installation_id`, `setup_action` and `state`.
 *
 * Pure jose; no I/O. The receiver supplies the issuer's keys.
 */
import { SignJWT, decodeJwt, decodeProtectedHeader, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import {
  importPrivateKey,
  importPublicJwk,
  SIGNING_ALGS,
  type PrivateKeyInput,
  type SigningAlg,
} from './keys';

/** JOSE `typ` of a link assertion. */
export const LINK_ASSERTION_TYP = 'codai-link+jwt';
/** Max lifetime of a link assertion (seconds). */
export const LINK_ASSERTION_MAX_LIFETIME_SEC = 300;
/** Query parameter carrying the assertion on the install URL. */
export const LINK_ASSERTION_PARAM = 'link_assertion';
/** `setup_action` values sent to the app's setup URL. */
export const SETUP_ACTIONS = ['install', 'update', 'uninstall'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

const NumericDate = z.number().int().nonnegative();
const State = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/, 'state must be URL-safe');

/** Organisation the origin user acts for (Brivio Space / company). */
export const LinkOrgSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  /** Fiscal id (RO: CUI, with or without the RO prefix). */
  tax_id: z.string().max(32).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
export type LinkOrg = z.infer<typeof LinkOrgSchema>;

/** Claims of a link assertion. `sub` is `user:<origin user id>`. */
export const LinkAssertionClaimsSchema = z
  .object({
    iss: z.url(),
    sub: z.string().regex(/^user:.+$/, 'sub must be user:<id>'),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    iat: NumericDate,
    exp: NumericDate,
    jti: z.string().min(8).max(128),
    /** Slug of the app being installed on the RECEIVING platform (e.g. `brivio` on codai). */
    app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    email: z.email().max(320),
    email_verified: z.literal(true),
    name: z.string().max(200).optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    org: LinkOrgSchema.optional(),
    /** Echo of the install `state`, binding the assertion to one redirect. */
    state: State,
  })
  .refine((c) => c.exp > c.iat, { message: 'exp must be after iat', path: ['exp'] })
  .refine((c) => c.exp - c.iat <= LINK_ASSERTION_MAX_LIFETIME_SEC, {
    message: `link assertion lifetime exceeds ${LINK_ASSERTION_MAX_LIFETIME_SEC} s`,
    path: ['exp'],
  });
export type LinkAssertionClaims = z.infer<typeof LinkAssertionClaimsSchema>;

/** Options of {@link signLinkAssertion}. */
export interface SignLinkAssertionOptions {
  issuer: string;
  audience: string;
  userId: string;
  app: string;
  email: string;
  state: string;
  privateKey: PrivateKeyInput;
  alg: SigningAlg;
  kid?: string | undefined;
  name?: string | undefined;
  locale?: string | undefined;
  org?: LinkOrg | undefined;
  /** Seconds since epoch (default now). */
  now?: number | undefined;
  /** Default 300 s. */
  lifetimeSec?: number | undefined;
}

/** Sign a link assertion (origin side). */
export async function signLinkAssertion(o: SignLinkAssertionOptions): Promise<string> {
  const iat = o.now ?? Math.floor(Date.now() / 1000);
  const lifetime = Math.min(
    o.lifetimeSec ?? LINK_ASSERTION_MAX_LIFETIME_SEC,
    LINK_ASSERTION_MAX_LIFETIME_SEC,
  );
  const claims = LinkAssertionClaimsSchema.parse({
    iss: o.issuer,
    sub: `user:${o.userId}`,
    aud: o.audience,
    iat,
    exp: iat + lifetime,
    jti: globalThis.crypto.randomUUID(),
    app: o.app,
    email: o.email.toLowerCase(),
    email_verified: true,
    ...(o.name ? { name: o.name } : {}),
    ...(o.locale ? { locale: o.locale } : {}),
    ...(o.org ? { org: o.org } : {}),
    state: o.state,
  });
  const key = await importPrivateKey(o.privateKey, o.alg);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: o.alg, typ: LINK_ASSERTION_TYP, ...(o.kid ? { kid: o.kid } : {}) })
    .sign(key);
}

/** Why a link assertion was rejected. */
export type LinkAssertionError =
  | 'malformed'
  | 'untrusted_issuer'
  | 'wrong_type'
  | 'bad_signature'
  | 'expired'
  | 'wrong_audience'
  | 'invalid_claims'
  | 'wrong_app'
  | 'state_mismatch';

/** Result of {@link verifyLinkAssertion}. */
export type VerifyLinkAssertionResult =
  | { ok: true; claims: LinkAssertionClaims; userId: string }
  | { ok: false; error: LinkAssertionError; message: string };

/** Options of {@link verifyLinkAssertion}. */
export interface VerifyLinkAssertionOptions {
  /** Resolve the trusted issuer's public keys, or null when the issuer is not trusted. */
  keysFor: (issuer: string) => Promise<JWK[] | null>;
  /** Accepted `aud` values (the receiver's issuer). */
  audience: string | string[];
  /** Expected app slug (from the install URL path). */
  app?: string | undefined;
  /** Expected state (from the install URL query). */
  state?: string | undefined;
  /** Clock (default now). */
  currentDate?: Date | undefined;
  clockToleranceSec?: number | undefined;
}

/** Peek the issuer without verifying (routing to the right key set). */
export function linkAssertionIssuer(token: string): string | null {
  try {
    const iss = decodeJwt(token).iss;
    return typeof iss === 'string' ? iss : null;
  } catch {
    return null;
  }
}

/** Verify a link assertion (receiver side). Never throws. */
export async function verifyLinkAssertion(
  token: string,
  o: VerifyLinkAssertionOptions,
): Promise<VerifyLinkAssertionResult> {
  const fail = (error: LinkAssertionError, message: string): VerifyLinkAssertionResult => ({
    ok: false,
    error,
    message,
  });
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return fail('malformed', 'link assertion is not a JWS');
  }
  if (header.typ !== LINK_ASSERTION_TYP)
    return fail('wrong_type', `typ must be ${LINK_ASSERTION_TYP}`);
  if (!header.alg || !(SIGNING_ALGS as readonly string[]).includes(header.alg))
    return fail('wrong_type', 'unsupported alg');
  const iss = linkAssertionIssuer(token);
  if (!iss) return fail('malformed', 'missing iss');
  const keys = await o.keysFor(iss);
  if (!keys || keys.length === 0) return fail('untrusted_issuer', `issuer ${iss} is not trusted`);
  const candidates = keys.filter((k) => !header.kid || !k.kid || k.kid === header.kid);
  let payload: Record<string, unknown> | null = null;
  let lastCode = '';
  for (const jwk of candidates) {
    try {
      const key = await importPublicJwk(jwk, header.alg);
      payload = (
        await jwtVerify(token, key, {
          issuer: iss,
          audience: o.audience,
          typ: LINK_ASSERTION_TYP,
          algorithms: [...SIGNING_ALGS],
          currentDate: o.currentDate,
          clockTolerance: o.clockToleranceSec ?? 30,
        })
      ).payload as Record<string, unknown>;
      break;
    } catch (e) {
      lastCode = typeof e === 'object' && e && 'code' in e ? String(e.code) : '';
      if (lastCode === 'ERR_JWT_EXPIRED' || lastCode === 'ERR_JWT_CLAIM_VALIDATION_FAILED') break;
    }
  }
  if (!payload) {
    if (lastCode === 'ERR_JWT_EXPIRED') return fail('expired', 'link assertion expired');
    if (lastCode === 'ERR_JWT_CLAIM_VALIDATION_FAILED')
      return fail('wrong_audience', 'link assertion audience or issuer mismatch');
    return fail('bad_signature', 'link assertion signature invalid');
  }
  const parsed = LinkAssertionClaimsSchema.safeParse(payload);
  if (!parsed.success)
    return fail('invalid_claims', parsed.error.issues[0]?.message ?? 'invalid claims');
  if (o.app !== undefined && parsed.data.app !== o.app)
    return fail('wrong_app', 'assertion is for another app');
  if (o.state !== undefined && parsed.data.state !== o.state)
    return fail('state_mismatch', 'state does not match the install request');
  return { ok: true, claims: parsed.data, userId: parsed.data.sub.slice('user:'.length) };
}

/** Build the receiver's install URL. */
export function buildInstallUrl(
  hubOrigin: string,
  appSlug: string,
  q: { state: string; assertion?: string | undefined },
): string {
  const u = new URL(`/apps/${encodeURIComponent(appSlug)}/install`, hubOrigin);
  u.searchParams.set('state', State.parse(q.state));
  if (q.assertion) u.searchParams.set(LINK_ASSERTION_PARAM, q.assertion);
  return u.toString();
}

/** Build the app's setup redirect after an install / update / uninstall. */
export function buildSetupRedirect(
  setupUrl: string,
  q: { installationId: string; action: SetupAction; state?: string | undefined },
): string {
  const u = new URL(setupUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')
    throw new Error('setup_url must be https');
  u.searchParams.set('installation_id', q.installationId);
  u.searchParams.set('setup_action', q.action);
  if (q.state) u.searchParams.set('state', q.state);
  return u.toString();
}
