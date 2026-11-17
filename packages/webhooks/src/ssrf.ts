// SSRF-safe webhook target validation (Standard Webhooks "Server side request forgery"):
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
// Ranges: IANA IPv4/IPv6 Special-Purpose Address Registries (RFC 6890 and updates).
//
// IMPORTANT: `validateWebhookUrl` only inspects the URL. A hostname that is public at
// validation time can resolve to a private address later (DNS rebinding). The sender MUST
// re-check the *resolved* IP with `isPrivateAddress` at connect time (custom DNS lookup /
// dispatcher, or an egress proxy such as smokescreen) and refuse redirects.

type V4Range = readonly [base: number, prefix: number];

const V4_BLOCKED: readonly V4Range[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (incl. cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
];

function inV4Range(addr: number, [base, prefix]: V4Range): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addr & mask) >>> 0 === base;
}

function parseV4Part(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0x[0-9a-f]*$/i.test(part))
    return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^(0|[1-9]\d*)$/.test(part)) return Number(part);
  return null;
}

/** Parse IPv4 in inet_aton forms (dotted, decimal, hex, octal, 1-4 parts) to a uint32, or null. */
export function parseIPv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length > 4) return null;
  const nums = parts.map(parseV4Part);
  if (nums.some((n) => n === null)) return null;
  const values = nums as number[];
  const last = values[values.length - 1] ?? 0;
  const head = values.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  if (last >= 2 ** (8 * (5 - values.length))) return null;
  let addr = 0;
  head.forEach((n, i) => {
    addr += n * 2 ** (8 * (3 - i));
  });
  return addr + last;
}

function expandV6Groups(input: string): string[] | null {
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) return left;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<string>(missing).fill('0'), ...right];
}

/** Parse an IPv6 literal (with optional brackets, zone id and IPv4 tail) into 8 groups, or null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  s = s.replace(/%.*$/, '');
  if (!s.includes(':')) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail?.[1]) {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(tail[1])
      ? parseIPv4(tail[1])
      : null;
    if (v4 === null) return null;
    s = `${s.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const groups = expandV6Groups(s);
  if (groups?.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

function isPrivateV4(addr: number): boolean {
  return V4_BLOCKED.some((range) => inV4Range(addr, range));
}

function embeddedV4(g: readonly number[], hi: number, lo: number): number {
  return ((g[hi] ?? 0) * 0x10000 + (g[lo] ?? 0)) >>> 0;
}

function isPrivateV6(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && (g5 === 0 || g5 === 0xffff))
    return g5 === 0xffff ? isPrivateV4(embeddedV4(g, 6, 7)) : true; // ::, ::1, ::/96, ::ffff:0:0/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isPrivateV4(embeddedV4(g, 6, 7)); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g0 === 0x2002) return isPrivateV4(embeddedV4(g, 1, 2)); // 6to4
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard
  if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23 IETF protocol (Teredo, ORCHID, ...)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x3fff && g1 < 0x1000) return true; // 3fff::/20 documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, site-local
  return (g0 & 0xff00) === 0xff00; // multicast
}

/** True when `ip` is a non-public address (private, loopback, link-local, CGNAT, ULA, reserved, multicast); re-check resolved IPs with this at connect time. */
export function isPrivateAddress(ip: string): boolean {
  const v6 = parseIPv6(ip);
  if (v6) return isPrivateV6(v6);
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isPrivateV4(v4);
  throw new TypeError(`not an IP address: ${ip}`);
}

/** True when `host` is an IPv4 (any inet_aton form) or IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  return parseIPv6(host) !== null || parseIPv4(host) !== null;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.lan',
];

/** Why a webhook URL was rejected. */
export type UrlRejectReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'private_address'
  | 'blocked_hostname';

/** Result of `validateWebhookUrl`. */
export type UrlValidationResult = { ok: true; url: URL } | { ok: false; reason: UrlRejectReason };

/** Options for `validateWebhookUrl`. */
export interface ValidateUrlOptions {
  /** Allow plain `http:` (dev only). */
  allowHttp?: boolean;
  /** Allow private/loopback addresses and internal hostnames (dev only). */
  allowPrivate?: boolean;
}

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return !host.includes('.'); // single-label names resolve via search domains to internal hosts
}

/** Validate a webhook target URL against SSRF rules; does not resolve DNS (see `isPrivateAddress`). */
export function validateWebhookUrl(
  input: string | URL,
  options: ValidateUrlOptions = {},
): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  const httpOk = url.protocol === 'http:' && options.allowHttp === true;
  if (url.protocol !== 'https:' && !httpOk) return { ok: false, reason: 'scheme_not_allowed' };
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'credentials_in_url' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return { ok: false, reason: 'invalid_url' };
  if (options.allowPrivate === true) return { ok: true, url };
  if (isIpLiteral(host))
    return isPrivateAddress(host) ? { ok: false, reason: 'private_address' } : { ok: true, url };
  if (isBlockedHostname(host)) return { ok: false, reason: 'blocked_hostname' };
  return { ok: true, url };
}
