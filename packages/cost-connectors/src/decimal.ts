/** Fixed scale of the minor units used for money arithmetic (micro units). */
export const DECIMAL_SCALE = 6;
const FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** True when `s` is a plain decimal string (`-12.5`, `0`, `3.000001`). */
export function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s);
}

/** Parse a decimal string to bigint micro units, rounding half away from zero beyond 6 decimals. */
export function toMicros(s: string): bigint {
  const m = DECIMAL_RE.exec(s.trim());
  if (!m) throw new RangeError(`not a decimal string: ${s}`);
  const [, sign, int = '0', frac = ''] = m;
  const head = frac.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, '0');
  let micros = BigInt(int) * FACTOR + BigInt(head);
  const next = frac.charCodeAt(DECIMAL_SCALE) - 48;
  if (next >= 5) micros += 1n;
  return sign === '-' ? -micros : micros;
}

/** Format bigint micro units as a decimal string, trimming trailing zeros (`1500000n` → `1.5`). */
export function fromMicros(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(DECIMAL_SCALE, '0').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : `${int}`;
  return neg && abs !== 0n ? `-${body}` : body;
}

function scaled(s: string, scale: number): bigint {
  const m = DECIMAL_RE.exec(s.trim());
  if (!m) throw new RangeError(`not a decimal string: ${s}`);
  const [, sign, int = '0', frac = ''] = m;
  const v = BigInt(int + frac.padEnd(scale, '0'));
  return sign === '-' ? -v : v;
}

/** Add decimal strings exactly at the largest input scale (no rounding). */
export function addDecimals(...values: string[]): string {
  const scale = Math.max(0, ...values.map((v) => (DECIMAL_RE.exec(v.trim())?.[3] ?? '').length));
  const sum = values.reduce((acc, v) => acc + scaled(v, scale), 0n);
  const neg = sum < 0n;
  const digits = (neg ? -sum : sum).toString().padStart(scale + 1, '0');
  const body = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return normalise(neg ? `-${body}` : body);
}

/**
 * Convert a JSON number or numeric string from an upstream API to a plain decimal string without
 * float arithmetic (expands exponent notation such as `1.2e-7`).
 */
export function toDecimalString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s =
    typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  if (isDecimalString(s)) return normalise(s);
  const m = /^([+-])?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) throw new RangeError(`not a number: ${String(value)}`);
  const [, sign = '', int = '0', frac = '', expStr = '0'] = m;
  const digits = int + frac;
  const point = int.length + Number(expStr);
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return normalise(sign + out);
}

function normalise(s: string): string {
  const m = DECIMAL_RE.exec(s);
  if (!m) return s;
  const [, sign, int = '0', frac = ''] = m;
  const i = int.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  const body = f ? `${i}.${f}` : i;
  return sign === '-' && /[1-9]/.test(body) ? `-${body}` : body;
}
