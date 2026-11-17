import { StoreValidationError } from './errors';

/** One file to put in a ZIP archive. */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3) of `data`. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const LIMIT = 0xffffffff;

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const b = new Uint8Array(30 + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0800, true); // UTF-8 names
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, 0, true);
  v.setUint16(12, DOS_DATE_1980_01_01, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, name.length, true);
  b.set(name, 30);
  return b;
}

function centralHeader(name: Uint8Array, crc: number, size: number, offset: number): Uint8Array {
  const b = new Uint8Array(46 + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, 0, true);
  v.setUint16(14, DOS_DATE_1980_01_01, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, name.length, true);
  v.setUint32(42, offset, true);
  b.set(name, 46);
  return b;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const b = new Uint8Array(22);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Build a deterministic, uncompressed (stored) ZIP archive; no ZIP64 (each file and the total < 4 GiB). */
export function createStoredZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length === 0 || entries.length > 0xffff)
    throw new StoreValidationError('zip needs 1..65535 entries');
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!e.name || e.name.startsWith('/') || e.name.includes('..'))
      throw new StoreValidationError(`bad zip entry name: ${e.name}`);
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const header = localHeader(name, crc, e.data.length);
    centrals.push(centralHeader(name, crc, e.data.length, offset));
    locals.push(header, e.data);
    offset += header.length + e.data.length;
    if (offset >= LIMIT) throw new StoreValidationError('zip larger than 4 GiB is not supported');
  }
  const cd = concat(centrals);
  return concat([...locals, cd, endRecord(entries.length, cd.length, offset)]);
}
