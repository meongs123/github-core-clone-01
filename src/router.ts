// Dispatcher: GET /healthz (no auth) → auth (every other route) → git / REST /
// GraphQL / MCP → 404 JSON. Auth is a single string equality against the env token.
import { jsonRes, emptyRes, type Req, type Res } from './http.ts';
import type { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { tryJson } from './util.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = `Bearer ${TOKEN}`;
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createHandler(store: Store): (req: Req) => Res {
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
  return (req: Req): Res => {
    // GET /healthz — the one unauthenticated route; the env boot check expects 200 {"ok":true}.
    if (req.method === 'GET' && req.path === '/healthz') return withRequestId(jsonRes(200, { ok: true }));

    // Auth for every other route (only when the token is set).
    if (TOKEN !== '' && req.headers.get('authorization') !== EXPECTED_AUTH) {
      return withRequestId(jsonRes(401, { message: 'Requires authentication' }));
    }

    // Git Smart HTTP.
    const gitMatch = GIT_ROUTE.exec(req.path);
    if (gitMatch !== null) {
      const owner = gitMatch[1] as string;
      const repoName = gitMatch[2] as string;
      const sub = gitMatch[3] as string;
      return withRequestId(handleGit(store, req, owner, repoName, sub));
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
}
