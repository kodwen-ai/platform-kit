/**
 * DSSE v1 pre-authentication encoding:
 * `"DSSEv1" SP len(type) SP type SP len(body) SP body`, lengths are UTF-8 byte counts.
 * Spec: https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 */
export function pae(payloadType: string, body: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(payloadType);
  const head = enc.encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${body.length} `);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}
