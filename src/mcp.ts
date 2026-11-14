// MCP Streamable HTTP: JSON-RPC 2.0, modern era (server/discover, revision 2026-07-28),
// plain-JSON answers, no sessions. Six tools over the same store as REST.
import { jsonRes, emptyRes, type Req, type Res } from './http.ts';
import type { Store } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the token owner)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Res {
  return jsonRes(200, { jsonrpc: '2.0', id, result });
}
function rpcError(id: unknown, code: number, message: string, status = 200): Res {
  return jsonRes(status, { jsonrpc: '2.0', id, error: { code, message } });
}
function toolResult(obj: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}
function toolError(message: string): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Recover a JSON-RPC id from a truncated body (for the parse-error response). */
function recoverId(text: string): unknown {
  const m = /"id"\s*:\s*(\d+|"(?:[^"\\]|\\.)*")/.exec(text);
  if (m === null) return null;
  const raw = m[1] as string;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return Number(raw);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw { code: -32601, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw { code: -32602, message: `Missing required argument: ${required}` };
    }
  }
  const owner = String(args['owner'] ?? '');
  const repoName = String(args['repo'] ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args['name'] ?? '');
      const repo = store.createRepo(repoNameArg, String(args['description'] ?? ''), args['private'] === true);
      if (repo === null) return toolError('Repository already exists');
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const result = store.createIssue(repo, String(args['title'] ?? ''), String(args['body'] ?? ''), []);
      if ('error' in result) return toolError(result.message);
      return toolResult({ id: result.dbid, number: result.number, title: result.title, body: result.body, state: result.state });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const state = String(args['state'] ?? 'open').toLowerCase();
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const items = list.map((i) => ({ id: i.dbid, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolResult(items);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const result = store.createPull(repo, String(args['title'] ?? ''), String(args['body'] ?? ''), String(args['head'] ?? ''), String(args['base'] ?? ''));
      if ('error' in result) return toolError(result.message);
      return toolResult({
        id: result.dbid,
        number: result.number,
        title: result.title,
        body: result.body,
        state: result.state,
        head: { ref: result.headRef, sha: result.headSha },
        base: { ref: result.baseRef, sha: result.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const num = Number(args['pull_number']);
      const pull = repo.pullByNumber(num);
      if (pull === undefined) return toolError('Pull request not found');
      const merged = store.squashMerge(repo, pull);
      if ('error' in merged) return toolError(merged.message);
      return toolResult({ number: pull.number, merged: true, sha: merged.sha });
    }
    default:
      throw { code: -32601, message: `Unknown tool: ${name}` };
  }
}

/** Handle POST/DELETE /mcp; returns null for other paths. */
export function handleMcp(store: Store, req: Req): Res | null {
  if (req.path !== '/mcp') return null;
  if (req.method === 'DELETE') return emptyRes(200);
  if (req.method !== 'POST') return jsonRes(405, { message: 'Method Not Allowed' });
  const text = req.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: HTTP 400 with JSON-RPC -32700, echoing the id when recoverable.
    return rpcError(recoverId(text), -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const msg = parsed as Record<string, unknown>;
  const id = msg['id'] ?? null;
  const method = msg['method'];
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const params = (msg['params'] ?? {}) as Record<string, unknown>;

  // Notifications (no id) never carry a result; 202 with an empty body.
  if (method === 'notifications/initialized') return emptyRes(202);

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'initialize': {
      const offered = typeof (params['protocolVersion'] as unknown) === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
      return rpcResult(id, {
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = params['name'];
      if (typeof toolName !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(id, -32602, 'Invalid params: arguments must be an object');
      }
      try {
        const result = callTool(store, toolName, args);
        return rpcResult(id, result);
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const e = err as { code: number; message: string };
          return rpcError(id, e.code, e.message);
        }
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
