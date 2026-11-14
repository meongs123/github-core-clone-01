// Shared low-level helpers: SHA-1, pkt-line framing, base64 ids, JSON.
// Pure Node 22 stdlib only. No Math.random / Date.now anywhere in the entry.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function sha1Buf(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

/** git object id: SHA-1 over "<type> <len>\0" + bytes. Chained update: zero copy. */
export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'ascii').update(data).digest('hex');
}

/** Parse 4 hex chars at `off` into a number; -1 when any char is not hex. No regex. */
export function parseHex4(buf: Buffer, off: number): number {
  let v = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = buf[off + i] as number;
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48; // 0-9
    else if (c >= 97 && c <= 102) d = c - 87; // a-f
    else if (c >= 65 && c <= 70) d = c - 55; // A-F
    else return -1;
    v = (v << 4) | d;
  }
  return v;
}

/** True when `s` is exactly 40 lowercase hex chars. No regex. */
export function isHex40(s: string): boolean {
  if (s.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** One pkt-line data packet for a string/Buffer payload (payload must fit). */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  // Payloads over 65516 bytes must be split by the caller; never emit an oversized packet.
  if (body.length + 4 > 65520) throw new Error('pkt-line payload too large');
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Encode a list of pkt-line items; 'flush'/'delim'/'response-end' are control packets. */
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_END);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

/**
 * Parse a pkt-line stream. Returns the data payloads in order plus the control packets seen.
 * Throws on a bad header, oversized packet, or trailing bytes.
 */
export function parsePktLines(buf: Buffer, offset = 0): { payloads: Buffer[]; controls: string[]; end: number } {
  const payloads: Buffer[] = [];
  const controls: string[] = [];
  let i = offset;
  while (i + 4 <= buf.length) {
    const head = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { controls.push('flush'); i += 4; continue; }
    if (len === 1) { controls.push('delim'); i += 4; continue; }
    if (len === 2) { controls.push('response-end'); i += 4; continue; }
    if (len < 4 || len > 65520) throw new Error('pkt-line length out of range');
    if (i + len > buf.length) throw new Error('pkt-line truncated');
    payloads.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  if (i !== buf.length) throw new Error('pkt-line trailing bytes');
  return { payloads, controls, end: i };
}

/** Split a buffer into sideband packets: payload = band byte + chunk (each pkt-line <= 65520). */
export function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX_CHUNK = 65520 - 4 - 1; // pkt-line header + band byte
  if (data.length === 0) {
    // An empty sideband packet is a protocol error; never emit one. Caller must avoid this.
    throw new Error('empty sideband packet');
  }
  for (let off = 0; off < data.length; off += MAX_CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + MAX_CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pkt(payload));
  }
  return Buffer.concat(parts);
}

/** base64 (standard) encode/decode for opaque global ids. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
export function b64decode(text: string): string | null {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** JSON stringify that never throws (falls back to '{}'). */
export function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? '{}';
}

/** Parse JSON, returning null on failure (caller decides the error). */
export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export { inflateSync, deflateSync };

/** Compare two buffers for equality without allocation. */
export function bufEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/** git tree sort key: directories sort as if their name ended in '/'. */
export function treeSortKey(name: string, isDir: boolean): string {
  return isDir ? name + '/' : name;
}

/** Split a string on '\n' into lines without the trailing newline; keeps empty trailing out. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
