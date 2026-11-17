/**
 * ECDSA P-256 signature encodings. Cloud KMS and node:crypto emit ASN.1 DER
 * (`SEQUENCE { INTEGER r, INTEGER s }`); WebCrypto verifies the raw 64-byte `r || s` form.
 */

const COORD = 32;

function readInt(der: Uint8Array, at: number): { value: Uint8Array; next: number } | null {
  if (der[at] !== 0x02) return null;
  const len = der[at + 1];
  if (len === undefined || len === 0 || len > 0x7f) return null;
  const start = at + 2;
  if (start + len > der.length) return null;
  let value = der.slice(start, start + len);
  while (value.length > COORD && value[0] === 0) value = value.slice(1);
  if (value.length > COORD) return null;
  return { value, next: start + len };
}

function seqBodyStart(der: Uint8Array): number | null {
  if (der[0] !== 0x30) return null;
  const len = der[1];
  if (len === undefined) return null;
  if (len & 0x80) {
    const n = len & 0x7f;
    return n === 1 && der.length > 2 ? 3 : null;
  }
  return 2;
}

/** DER ECDSA P-256 signature → raw 64-byte `r || s`; null when the DER is malformed. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  let at = seqBodyStart(der);
  if (at === null) return null;
  const out = new Uint8Array(COORD * 2);
  for (let k = 0; k < 2; k++) {
    const int = readInt(der, at);
    if (!int) return null;
    out.set(int.value, k * COORD + (COORD - int.value.length));
    at = int.next;
  }
  return at === der.length ? out : null;
}

function encodeInt(coord: Uint8Array): Uint8Array {
  let start = 0;
  while (start < coord.length - 1 && coord[start] === 0) start++;
  const body = coord.slice(start);
  const pad = (body[0] ?? 0) & 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + body.length);
  out[0] = 0x02;
  out[1] = pad + body.length;
  out.set(body, 2 + pad);
  return out;
}

/** Raw 64-byte `r || s` P-256 signature → minimal DER; throws RangeError on a wrong length. */
export function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (raw.length !== COORD * 2)
    throw new RangeError(`raw P-256 signature must be 64 bytes, got ${raw.length}`);
  const r = encodeInt(raw.slice(0, COORD));
  const s = encodeInt(raw.slice(COORD));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}
