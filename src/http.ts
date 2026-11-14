// Minimal HTTP/1.1 keep-alive server on node:net (no node:http on the hot path).
// Supports: persistent keep-alive, pipelined requests in one TCP chunk, partial chunks,
// Content-Length, Transfer-Encoding: chunked, Expect: 100-continue.
// Every response is ONE socket.write of a single Buffer (head + body, explicit Content-Length).
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { jsonText } from './util.ts';

export interface Req {
  method: string;
  /** Decoded pathname (no query string, no trailing-slash normalisation). */
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  host: string;
  keepAlive: boolean;
}

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Complete framed HTTP/1.1 response (status + headers + body in one Buffer).
   * When set, the socket writes it directly — no frameResponse, no concat. */
  rawHttpBuf?: Buffer;
}

export type Handler = (req: Req) => Res;

/** Minimal zero-alloc request view for the fast path: one complete HTTP/1.1
 * request in a single TCP chunk. `path` is the raw path (no query, no percent
 * decoding — the fast path only handles paths that need none). */
export interface FastReq {
  method: string;
  path: string;
  query: string;
  body: Buffer;
  keepAlive: boolean;
  /** `git-protocol: version=2` header present (upload-pack v2 vs v0). */
  gitProtocolV2: boolean;
}

/** A fast dispatcher: returns a complete framed HTTP response Buffer, or null
 * to fall back to the full parser. Attached to the handler by the router. */
export type FastHandler = (req: FastReq) => Buffer | null;

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EMPTY_BUF = Buffer.alloc(0);
const CONTINUE_BUF = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export function jsonRes(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Res {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(jsonText(body), 'utf8'),
  };
}

export function emptyRes(status: number, extraHeaders: Record<string, string> = {}): Res {
  return { status, headers: { ...extraHeaders }, body: Buffer.alloc(0) };
}

/** Frame one response into a single Buffer. `connection: keep-alive` is the
 * HTTP/1.1 default and is omitted; `connection: close` is sent only when the
 * server is closing the socket. */
function frameResponse(res: Res, keepAlive: boolean): Buffer {
  const headLines: string[] = [`HTTP/1.1 ${res.status} ${REASONS[res.status] ?? ''}`];
  for (const [k, v] of Object.entries(res.headers)) headLines.push(`${k}: ${v}`);
  headLines.push(`content-length: ${res.body.length}`);
  if (!keepAlive) headLines.push('connection: close');
  const head = Buffer.from(headLines.join('\r\n') + '\r\n\r\n', 'ascii');
  return res.body.length === 0 ? head : Buffer.concat([head, res.body]);
}

/** Build a complete framed HTTP/1.1 response Buffer from a status, an ordered
 * list of header lines (already `name: value`), and a body. One allocation. */
export function frameHttp(status: number, headerLines: string[], body: Buffer): Buffer {
  const head = Buffer.from(`HTTP/1.1 ${status} ${REASONS[status] ?? ''}\r\n${headerLines.join('\r\n')}\r\ncontent-length: ${body.length}\r\n\r\n`, 'ascii');
  return body.length === 0 ? head : Buffer.concat([head, body]);
}

// ------------------------------------------------------------ fast-path byte helpers

/** ASCII lowercase of one byte (A-Z -> a-z, everything else unchanged). */
function lowerByte(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** Case-insensitive compare of chunk[off..off+len] against a lowercase string. */
function nameEq(chunk: Buffer, off: number, len: number, name: string): boolean {
  if (len !== name.length) return false;
  for (let i = 0; i < len; i += 1) {
    if (lowerByte(chunk[off + i] as number) !== name.charCodeAt(i)) return false;
  }
  return true;
}

/** Case-insensitive compare of chunk[start..end] against a lowercase string. */
function valueEq(chunk: Buffer, start: number, end: number, value: string): boolean {
  if (end - start !== value.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (lowerByte(chunk[start + i] as number) !== value.charCodeAt(i)) return false;
  }
  return true;
}

/** Parse decimal digits in chunk[start..end]; -1 on any non-digit or empty. */
function parseDec(chunk: Buffer, start: number, end: number): number {
  if (end <= start) return -1;
  let v = 0;
  for (let i = start; i < end; i += 1) {
    const c = chunk[i] as number;
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
    if (v > MAX_BODY_BYTES) return -1;
  }
  return v;
}

/** Case-insensitive substring search of `needle` (lowercase) in chunk[start..end]. */
function valueContains(chunk: Buffer, start: number, end: number, needle: string): boolean {
  const n = needle.length;
  if (n === 0 || end - start < n) return false;
  outer: for (let i = start; i + n <= end; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (lowerByte(chunk[i + j] as number) !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

interface FastHead {
  method: string;
  target: string;
  contentLength: number;
  auth: Buffer | null;
  gitProtocolV2: boolean;
  keepAlive: boolean;
  chunked: boolean;
}

/** Parse the request line + headers of one complete HTTP/1.1 request from the
 * raw chunk bytes, in a single pass, with no toString of the head, no split,
 * no regex, no Map. Returns null when the request is not fast-path shaped.
 * Fills and returns the module scratch head (synchronous dispatch only). */
const SCRATCH_HEAD: FastHead = { method: '', target: '', contentLength: 0, auth: null, gitProtocolV2: false, keepAlive: true, chunked: false };
function scanFastHead(chunk: Buffer, headerEnd: number): FastHead | null {
  const lineEnd = chunk.indexOf('\r\n', 0);
  if (lineEnd < 0 || lineEnd > headerEnd) return null;
  const sp1 = chunk.indexOf(0x20, 0);
  if (sp1 < 0 || sp1 >= lineEnd) return null;
  const sp2 = chunk.indexOf(0x20, sp1 + 1);
  if (sp2 < 0 || sp2 >= lineEnd) return null;
  // Method by bytes (GET / POST only — the fast dispatcher serves nothing
  // else, so any other method falls back to the full parser). No toString.
  let method: string;
  if (sp1 === 3 && chunk[0] === 0x47 && chunk[1] === 0x45 && chunk[2] === 0x54) method = 'GET';
  else if (sp1 === 4 && chunk[0] === 0x50 && chunk[1] === 0x4f && chunk[2] === 0x53 && chunk[3] === 0x54) method = 'POST';
  else return null;
  // Version by bytes: 'HTTP/1.1' (8 bytes). No toString.
  if (lineEnd - (sp2 + 1) !== 8) return null;
  if (
    chunk[sp2 + 1] !== 0x48 || chunk[sp2 + 2] !== 0x54 || chunk[sp2 + 3] !== 0x54 || chunk[sp2 + 4] !== 0x50 ||
    chunk[sp2 + 5] !== 0x2f || chunk[sp2 + 6] !== 0x31 || chunk[sp2 + 7] !== 0x2e || chunk[sp2 + 8] !== 0x31
  ) return null;
  const target = chunk.toString('ascii', sp1 + 1, sp2);
  const head = SCRATCH_HEAD;
  head.method = method;
  head.target = target;
  head.contentLength = 0;
  head.auth = null;
  head.gitProtocolV2 = false;
  head.keepAlive = true;
  head.chunked = false;
  let i = lineEnd + 2;
  while (i < headerEnd) {
    const eol = chunk.indexOf('\r\n', i);
    if (eol < 0 || eol > headerEnd) return null;
    const colon = chunk.indexOf(0x3a, i);
    if (colon < 0 || colon >= eol) return null;
    const nameLen = colon - i;
    let vStart = colon + 1;
    while (vStart < eol && (chunk[vStart] === 0x20 || chunk[vStart] === 0x09)) vStart += 1;
    let vEnd = eol;
    while (vEnd > vStart && (chunk[vEnd - 1] === 0x20 || chunk[vEnd - 1] === 0x09)) vEnd -= 1;
    // Dispatch on the header-name length (all five names we care about have
    // distinct lengths: 10/12/13/14/17), then one nameEq to verify — instead
    // of five nameEq calls per header. nameEq compares byte-by-byte and fails
    // fast on the first byte, so a separate first-byte pre-check adds nothing.
    switch (nameLen) {
      case 13:
        if (nameEq(chunk, i, nameLen, 'authorization')) head.auth = chunk.subarray(vStart, vEnd);
        break;
      case 14:
        if (nameEq(chunk, i, nameLen, 'content-length')) {
          head.contentLength = parseDec(chunk, vStart, vEnd);
          if (head.contentLength < 0) return null;
        }
        break;
      case 12:
        if (nameEq(chunk, i, nameLen, 'git-protocol')) head.gitProtocolV2 = valueEq(chunk, vStart, vEnd, 'version=2');
        break;
      case 10:
        if (nameEq(chunk, i, nameLen, 'connection')) head.keepAlive = !valueEq(chunk, vStart, vEnd, 'close');
        break;
      case 17:
        if (nameEq(chunk, i, nameLen, 'transfer-encoding')) head.chunked = valueContains(chunk, vStart, vEnd, 'chunked');
        break;
      default:
        break;
    }
    i = eol + 2;
  }
  return head;
}

/** True when the head bytes (up to headerEnd) carry `Expect: 100-continue`.
 * Single byte-level pass; only called for POST/PUT with an incomplete body. */
function hasExpectContinue(buf: Buffer, headerEnd: number): boolean {
  // 'expect' at a line start (preceded by '\n'), case-insensitive.
  for (let i = 0; i + 6 <= headerEnd; i += 1) {
    const c = buf[i] as number;
    if (c !== 0x65 && c !== 0x45) continue; // 'e' / 'E'
    if (i > 0 && buf[i - 1] !== 0x0a) continue;
    if (
      lowerByte(buf[i + 1] as number) !== 0x78 || // x
      lowerByte(buf[i + 2] as number) !== 0x70 || // p
      lowerByte(buf[i + 3] as number) !== 0x65 || // e
      lowerByte(buf[i + 4] as number) !== 0x63 || // c
      lowerByte(buf[i + 5] as number) !== 0x74 // t
    ) continue;
    let j = i + 6;
    while (j < headerEnd && (buf[j] === 0x20 || buf[j] === 0x09)) j += 1;
    if (buf[j] !== 0x3a) continue; // ':'
    j += 1;
    while (j < headerEnd && (buf[j] === 0x20 || buf[j] === 0x09)) j += 1;
    if (j + 12 <= headerEnd && valueEq(buf, j, j + 12, '100-continue')) return true;
  }
  return false;
}

/** Module scratch for the fast-path request view (synchronous dispatch only:
 * filled, handed to the dispatcher, and never retained past the call). */
const SCRATCH_REQ: FastReq = { method: '', path: '', query: '', body: EMPTY_BUF, keepAlive: true, gitProtocolV2: false };

/** Try the zero-alloc fast path for the request at the START of `buf`.
 * Returns the number of bytes consumed (> 0) when one complete request at
 * the front of `buf` was answered, or 0 when `buf` holds no complete
 * fast-path request (incomplete body, chunked, unauthenticated, or
 * unshaped) — the caller then falls back to the full parser on the same
 * buffer. Leftover bytes (a pipelined next request) stay in `buf` for the
 * next loop iteration. */
function tryFastHandleBuf(buf: Buffer, socket: Socket, handler: Handler & { fast?: FastHandler }, fastAuthBuf: Buffer | null): number {
  const fast = handler.fast;
  if (fast === undefined) return 0;
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) return 0;
  const head = scanFastHead(buf, headerEnd);
  if (head === null || head.chunked) return 0;
  const bodyStart = headerEnd + 4;
  if (bodyStart + head.contentLength > buf.length) return 0; // incomplete body
  // Auth: the fast path only serves requests that already pass it; anything
  // else falls back to the full parser (which answers the 401).
  if (fastAuthBuf !== null) {
    if (head.auth === null || !head.auth.equals(fastAuthBuf)) return 0;
  }
  // The fast path does no percent-decoding: a '%' in the target falls back.
  if (head.target.indexOf('%') >= 0) return 0;
  const q = head.target.indexOf('?');
  const req = SCRATCH_REQ;
  req.method = head.method;
  req.path = q >= 0 ? head.target.slice(0, q) : head.target;
  req.query = q >= 0 ? head.target.slice(q + 1) : '';
  req.body = buf.subarray(bodyStart, bodyStart + head.contentLength);
  req.keepAlive = head.keepAlive;
  req.gitProtocolV2 = head.gitProtocolV2;
  const resp = fast(req);
  if (resp === null) return 0;
  socket.write(resp);
  if (!head.keepAlive) socket.end();
  return bodyStart + head.contentLength;
}

interface Pending {
  buf: Buffer;
  continueSent: boolean;
}

/** Decode one chunked body starting at `start`; returns {body, end} or null if incomplete. */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; end: number } | null {
  const chunks: Buffer[] = [];
  let i = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) return null;
    const sizeText = buf.toString('ascii', i, lineEnd).split(';')[0]?.trim() ?? '';
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailer part: lines until an empty line.
      let j = dataStart;
      for (;;) {
        const e = buf.indexOf('\r\n', j);
        if (e < 0) return null;
        if (e === j) return { body: Buffer.concat(chunks), end: e + 2 };
        j = e + 2;
      }
    }
    if (dataStart + size + 2 > buf.length) return null;
    chunks.push(buf.subarray(dataStart, dataStart + size));
    i = dataStart + size + 2;
  }
}

/** Try to parse one complete request from the front of `state.buf`. Returns the request or null. */
function tryParse(state: Pending): { req: Req; consumed: number } | null {
  const buf = state.buf;
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('headers too large');
    return null;
  }
  const headText = buf.toString('ascii', 0, headerEnd);
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const m = /^([A-Z]+) ([^ ]+) HTTP\/(\d\.\d)$/.exec(requestLine);
  if (m === null) throw new Error('bad request line');
  const method = m[1] as string;
  const target = m[2] as string;
  const version = m[3] as string;
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const bodyStart = headerEnd + 4;
  const chunked = (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
  let body: Buffer;
  let consumed: number;
  if (chunked) {
    const decoded = decodeChunked(buf, bodyStart);
    if (decoded === null) return null;
    body = decoded.body;
    consumed = decoded.end;
  } else {
    const lenText = headers.get('content-length');
    const len = lenText === undefined ? 0 : parseInt(lenText, 10);
    if (!Number.isFinite(len) || len < 0) throw new Error('bad content-length');
    if (len > MAX_BODY_BYTES) throw new Error('body too large');
    if (buf.length < bodyStart + len) return null;
    body = buf.subarray(bodyStart, bodyStart + len);
    consumed = bodyStart + len;
  }
  if (body.length > MAX_BODY_BYTES) throw new Error('body too large');
  // Split target into path + query. Decode percent-escapes per segment (tolerantly).
  const q = target.indexOf('?');
  const rawPath = q >= 0 ? target.slice(0, q) : target;
  const query = new URLSearchParams(q >= 0 ? target.slice(q + 1) : '');
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  const connection = (headers.get('connection') ?? '').toLowerCase();
  const keepAlive = version === '1.1' ? connection !== 'close' : connection === 'keep-alive';
  return {
    req: {
      method,
      path,
      query,
      headers,
      body,
      host: headers.get('host') ?? '',
      keepAlive,
    },
    consumed,
  };
}

/** Server wrapper with the same surface main.ts expects from the starter (listen/address/close/once). */
export class ForgeServer {
  private server: NetServer;
  private handler: Handler & { fast?: FastHandler; fastAuth?: string };
  /** Expected `Authorization` value as bytes, computed once (null = no auth). */
  private fastAuthBuf: Buffer | null;

  constructor(handler: Handler & { fast?: FastHandler; fastAuth?: string }) {
    this.handler = handler;
    const fa = handler.fastAuth ?? '';
    this.fastAuthBuf = fa === '' ? null : Buffer.from(fa, 'ascii');
    this.server = createNetServer((socket: Socket) => this.onSocket(socket));
  }

  once(event: 'error', listener: (err: Error) => void): void {
    this.server.once(event, listener);
  }

  listen(port: number, cb: () => void): void {
    // Explicit backlog for the 50-concurrent-accept burst of the clone workload.
    this.server.listen({ port, backlog: 511 }, cb);
  }

  address(): { port: number } | null {
    const a = this.server.address();
    if (a === null || typeof a === 'string') return null;
    return { port: a.port };
  }

  close(): void {
    this.server.close();
  }

  private onSocket(socket: Socket): void {
    socket.setNoDelay(true);
    const state: Pending = { buf: EMPTY_BUF, continueSent: false };
    socket.on('data', (chunk: Buffer) => {
      state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
      try {
        for (;;) {
          // Zero-alloc fast path, on the merged buffer: a complete request at
          // the front — whether it arrived in one chunk or the POST body
          // arrived in a later TCP packet. Consumes exactly the request and
          // loops for any pipelined remainder.
          const consumed = tryFastHandleBuf(state.buf, socket, this.handler, this.fastAuthBuf);
          if (consumed > 0) {
            state.buf = consumed === state.buf.length ? EMPTY_BUF : state.buf.subarray(consumed);
            state.continueSent = false;
            if (socket.writableEnded) return;
            if (state.buf.length === 0) break;
            continue;
          }
          // Answer Expect: 100-continue as soon as the headers are in — but
          // only for POST/PUT with a body not yet complete, in one byte pass.
          if (!state.continueSent) {
            const he = state.buf.indexOf('\r\n\r\n');
            if (he >= 0) {
              const isPostPut =
                (state.buf[0] === 0x50 && state.buf[1] === 0x4f && state.buf[2] === 0x53 && state.buf[3] === 0x54) || // POST
                (state.buf[0] === 0x50 && state.buf[1] === 0x55 && state.buf[2] === 0x54); // PUT
              if (isPostPut && hasExpectContinue(state.buf, he)) {
                socket.write(CONTINUE_BUF);
              }
              state.continueSent = true;
            }
          }
          const parsed = tryParse(state);
          if (parsed === null) break;
          // Release the chunk when fully consumed instead of pinning it with
          // a zero-length subarray view.
          state.buf = parsed.consumed === state.buf.length ? EMPTY_BUF : state.buf.subarray(parsed.consumed);
          state.continueSent = false;
          let res: Res;
          try {
            res = this.handler(parsed.req);
          } catch (err) {
            process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
            res = jsonRes(500, { message: 'Internal Server Error' });
          }
          const keepAlive = parsed.req.keepAlive;
          // A pre-framed response goes out as-is: one write, zero framing.
          socket.write(res.rawHttpBuf !== undefined ? res.rawHttpBuf : frameResponse(res, keepAlive));
          if (!keepAlive) {
            socket.end();
            return;
          }
        }
      } catch (err) {
        // Malformed request: answer 400 JSON once, then close.
        try {
          socket.write(frameResponse(jsonRes(400, { message: 'Bad Request' }), false));
        } catch {
          // ignore
        }
        socket.destroy();
      }
    });
    socket.on('error', () => {
      socket.destroy();
    });
  }
}

export function createForgeServer(handler: Handler & { fast?: FastHandler; fastAuth?: string }): ForgeServer {
  return new ForgeServer(handler);
}
