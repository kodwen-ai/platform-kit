const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Encode bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode strict standard base64; returns null when the input is not valid base64. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> | null {
  if (input.length % 4 !== 0 || !BASE64_RE.test(input)) return null;
  let binary: string;
  try {
    binary = atob(input);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Compare two byte arrays in time independent of where they differ. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
