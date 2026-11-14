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
}

export type Handler = (req: Req) => Res;

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

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
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(jsonText(body) + '\n', 'utf8'),
  };
}

export function emptyRes(status: number, extraHeaders: Record<string, string> = {}): Res {
  return { status, headers: { ...extraHeaders }, body: Buffer.alloc(0) };
}

/** Frame one response into a single Buffer. */
function frameResponse(res: Res, keepAlive: boolean): Buffer {
  const headLines: string[] = [`HTTP/1.1 ${res.status} ${REASONS[res.status] ?? ''}`];
  for (const [k, v] of Object.entries(res.headers)) headLines.push(`${k}: ${v}`);
  headLines.push(`content-length: ${res.body.length}`);
  headLines.push(`connection: ${keepAlive ? 'keep-alive' : 'close'}`);
  const head = Buffer.from(headLines.join('\r\n') + '\r\n\r\n', 'ascii');
  return res.body.length === 0 ? head : Buffer.concat([head, res.body]);
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
  const expect = headers.get('expect') ?? '';
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
      body: Buffer.from(body),
      host: headers.get('host') ?? '',
      keepAlive,
    },
    consumed,
  };
}

/** Server wrapper with the same surface main.ts expects from the starter (listen/address/close/once). */
export class ForgeServer {
  private server: NetServer;
  private handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
    this.server = createNetServer((socket: Socket) => this.onSocket(socket));
  }

  once(event: 'error', listener: (err: Error) => void): void {
    this.server.once(event, listener);
  }

  listen(port: number, cb: () => void): void {
    this.server.listen(port, cb);
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
    const state: Pending = { buf: Buffer.alloc(0), continueSent: false };
    socket.on('data', (chunk: Buffer) => {
      state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
      try {
        for (;;) {
          // Answer Expect: 100-continue as soon as the headers are in.
          if (!state.continueSent) {
            const he = state.buf.indexOf('\r\n\r\n');
            if (he >= 0) {
              const headText = state.buf.toString('ascii', 0, he).toLowerCase();
              if (headText.includes('expect: 100-continue')) {
                socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii'));
              }
              state.continueSent = true;
            }
          }
          const parsed = tryParse(state);
          if (parsed === null) break;
          state.buf = state.buf.subarray(parsed.consumed);
          state.continueSent = false;
          let res: Res;
          try {
            res = this.handler(parsed.req);
          } catch (err) {
            process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
            res = jsonRes(500, { message: 'Internal Server Error' });
          }
          const keepAlive = parsed.req.keepAlive;
          socket.write(frameResponse(res, keepAlive));
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

export function createForgeServer(handler: Handler): ForgeServer {
  return new ForgeServer(handler);
}
