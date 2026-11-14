// Dispatcher: GET /healthz (no auth) → auth (every other route) → git / REST /
// GraphQL / MCP → 404 JSON. Auth is a single string equality against the env token.
//
// Path dispatch is prefix-first with indexOf/slice parsing — no regex on the
// hot path, and the git route regex never runs on /api/v3/... requests. The
// router also owns the zero-alloc fast-path dispatcher (handler.fast), which
// answers pure cache hits straight from the socket buffer.
import { jsonRes, frameHttp, type Req, type Res, type FastReq } from './http.ts';
import type { Store } from './store.ts';
import { handleGit, V2_INFO_REFS_HTTP_BUF, receivePackInfoRefsBuf, uploadPackFastBuf } from './git.ts';
import { handleRest, fastGetIssueBuf, fastCreateIssue } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { tryJson } from './util.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

/** Complete framed HTTP/1.1 200 response for GET /healthz. Constant. */
const HEALTHZ_HTTP_BUF: Buffer = frameHttp(200, ['content-type: application/json', 'x-github-request-id: req-healthz'], Buffer.from('{"ok":true}\n', 'utf8'));

/** Parse a git path `/<owner>/<repo>.git/<sub>` with indexOf (no regex).
 * Returns [owner, repo, sub] or null. */
function parseGitPath(path: string): [string, string, string] | null {
  if (!path.startsWith('/')) return null;
  const slash2 = path.indexOf('/', 1);
  if (slash2 < 0) return null;
  const owner = path.slice(1, slash2);
  const rest = path.slice(slash2 + 1);
  if (!rest.endsWith('.git/info/refs') && !rest.endsWith('.git/git-upload-pack') && !rest.endsWith('.git/git-receive-pack')) return null;
  const dotGit = rest.lastIndexOf('.git/');
  if (dotGit < 0) return null;
  const repo = rest.slice(0, dotGit);
  const sub = rest.slice(dotGit + 5);
  if (owner === '' || repo === '' || (sub !== 'info/refs' && sub !== 'git-upload-pack' && sub !== 'git-receive-pack')) return null;
  return [owner, repo, sub];
}

/** Parse a REST repo path `/api/v3/repos/<owner>/<repo>/...` with indexOf.
 * Returns [owner, repo, tail] (tail = path after the repo name, '' when the
 * path ends at the repo) or null. */
function parseRestRepoPath(path: string): [string, string, string] | null {
  const prefix = '/api/v3/repos/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return [rest, '', ''];
  const owner = rest.slice(0, slash);
  const after = rest.slice(slash + 1);
  const slash2 = after.indexOf('/');
  if (slash2 < 0) return [owner, after, ''];
  return [owner, after.slice(0, slash2), after.slice(slash2 + 1)];
}

type FastableHandler = ((req: Req) => Res) & {
  fast: (freq: FastReq) => Buffer | null;
  fastAuth: string;
};

export function createHandler(store: Store): FastableHandler {
  // Every JSON reply carries a deterministic request id (the spec requires a
  // non-empty X-GitHub-Request-Id on every REST reply). Handlers that already
  // set one (cached issue GET) keep theirs.
  const withRequestId = (res: Res): Res => {
    const ct = res.headers['content-type'] ?? '';
    if (ct.includes('application/json') && res.headers['x-github-request-id'] === undefined) {
      res.headers['x-github-request-id'] = store.requestId();
    }
    return res;
  };

  const handler = (req: Req): Res => {
    // GET /healthz — the one unauthenticated route; the env boot check expects 200 {"ok":true}.
    if (req.method === 'GET' && req.path === '/healthz') return withRequestId(jsonRes(200, { ok: true }));

    // Auth for every other route (only when the token is set).
    if (TOKEN !== '' && req.headers.get('authorization') !== EXPECTED_AUTH) {
      return withRequestId(jsonRes(401, { message: 'Requires authentication' }));
    }

    // Git Smart HTTP (only when the path is not under /api/v3).
    if (!req.path.startsWith('/api/v3')) {
      const git = parseGitPath(req.path);
      if (git !== null) {
        return withRequestId(handleGit(store, req, git[0], git[1], git[2]));
      }
    }

    // MCP.
    if (req.path === '/mcp') return withRequestId(handleMcp(store, req) ?? jsonRes(404, { message: 'Not Found' }));

    // REST + GraphQL share the JSON body parser: malformed JSON is HTTP 400.
    if (req.path.startsWith('/api/v3') || req.path === '/api/graphql') {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        if (req.body.length > 0) {
          const parsed = tryJson(req.body);
          if (parsed === undefined) return withRequestId(jsonRes(400, { message: 'Request body must be JSON' }));
          (req as Req & { json?: unknown }).json = parsed;
        } else {
          (req as Req & { json?: unknown }).json = undefined;
        }
      }
      if (req.path === '/api/graphql') return withRequestId(handleGraphql(store, req) ?? jsonRes(404, { message: 'Not Found' }));
      return withRequestId(handleRest(store, req));
    }

    return withRequestId(jsonRes(404, { message: 'Not Found' }));
  };

  // ---- zero-alloc fast path (one complete request in one TCP chunk) ----
  // Returns a complete framed HTTP response Buffer, or null to fall back to
  // the full parser. Auth was already validated by the socket layer.
  const fast = (freq: FastReq): Buffer | null => {
    // GET /healthz (unauthenticated). The counter advances once, matching
    // the full path's one requestId() call per healthz.
    if (freq.method === 'GET' && freq.path === '/healthz' && freq.query === '') {
      store.counter += 1;
      return HEALTHZ_HTTP_BUF;
    }

    // Git Smart HTTP.
    if (!freq.path.startsWith('/api/v3')) {
      const git = parseGitPath(freq.path);
      if (git !== null) {
        const [owner, repoName, sub] = git;
        if (sub === 'info/refs' && freq.method === 'GET') {
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) return null;
          if (freq.query === 'service=git-upload-pack' && freq.gitProtocolV2) {
            // Clone workload: v2 advertisement, constant.
            return V2_INFO_REFS_HTTP_BUF;
          }
          if (freq.query === 'service=git-receive-pack') {
            // Push workload: single-ref main, template-filled.
            return receivePackInfoRefsBuf(repo);
          }
          return null;
        }
        // git-upload-pack POSTs (ls-refs/fetch): serve the pre-framed response
        // from the raw-body cache when this exact body was answered before.
        // The socket layer only calls this dispatcher when the chunk holds
        // exactly one complete request (bodyStart + contentLength === length),
        // so the fast path can never leave leftover bytes behind to corrupt
        // keep-alive; a miss falls back to the full parser.
        if (sub === 'git-upload-pack' && freq.method === 'POST') {
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) return null;
          return uploadPackFastBuf(repo, freq.body, freq.gitProtocolV2);
        }
        return null;
      }
    }

    // REST issue fast paths.
    if (freq.path.startsWith('/api/v3/repos/')) {
      const parsed = parseRestRepoPath(freq.path);
      if (parsed !== null) {
        const [owner, repoName, tail] = parsed;
        if (freq.method === 'GET' && tail.startsWith('issues/')) {
          const num = Number(tail.slice('issues/'.length));
          if (!Number.isSafeInteger(num) || num < 1 || tail.slice('issues/'.length).includes('/')) return null;
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) return null;
          return fastGetIssueBuf(store, repo, num);
        }
        if (freq.method === 'POST' && tail === 'issues' && freq.query === '') {
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) return null;
          return fastCreateIssue(store, repo, freq.body);
        }
      }
    }

    return null;
  };

  (handler as FastableHandler).fast = fast;
  (handler as FastableHandler).fastAuth = EXPECTED_AUTH;
  return handler as FastableHandler;
}
