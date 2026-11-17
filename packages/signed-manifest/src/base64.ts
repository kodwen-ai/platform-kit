const STD_B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard (RFC 4648 §4) base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Strict standard base64 decode accepting input with or without `=` padding; null on any
 * other character (url-safe alphabet, whitespace) or an impossible length.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!STD_B64.test(text)) return null;
  const core = text.replace(/=+$/, '');
  if (core.length % 4 === 1) return null;
  const padded = text.includes('=') ? text : core + '='.repeat((4 - (core.length % 4)) % 4);
  if (padded.length % 4 !== 0) return null;
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
