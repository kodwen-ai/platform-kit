const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/;
const NUMERIC_RE = /^\d+$/;

interface ParsedSemver {
  core: [bigint, bigint, bigint];
  pre: string[];
}

function parse(v: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    core: [BigInt(m[1] ?? '0'), BigInt(m[2] ?? '0'), BigInt(m[3] ?? '0')],
    pre: m[4] ? m[4].split('.') : [],
  };
}

function cmp<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
  const an = NUMERIC_RE.test(a);
  const bn = NUMERIC_RE.test(b);
  if (an && bn) return cmp(BigInt(a), BigInt(b));
  if (an) return -1;
  if (bn) return 1;
  return cmp(a, b);
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = compareIdentifier(a[i] ?? '', b[i] ?? '');
    if (d !== 0) return d;
  }
  return cmp(a.length, b.length);
}

/**
 * SemVer 2.0 precedence (-1/0/1), build metadata ignored; same rules as the web/phone/desktop updaters.
 * Unparseable versions sort below every valid version (and equal to each other).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = cmp(pa.core[i], pb.core[i]);
    if (d !== 0) return d;
  }
  return comparePre(pa.pre, pb.pre);
}
