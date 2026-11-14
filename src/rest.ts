// REST v3 API under /api/v3. Every reply is JSON with X-GitHub-Request-Id (added by the
// router). Unknown routes are 404 {"message":"Not Found"}; malformed JSON bodies are 400.
import { jsonRes, emptyRes, type Req, type Res } from './http.ts';
import type { Store, Repo, Issue, Pull, Comment } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL } from './store.ts';
import { parseCommit, parseTree } from './gitpack.ts';

export interface Ctx {
  store: Store;
  req: Req;
}

function notFound(): Res {
  return jsonRes(404, { message: 'Not Found' });
}
function badRequest(message: string): Res {
  return jsonRes(400, { message });
}
function unprocessable(message: string): Res {
  return jsonRes(422, { message });
}

// ------------------------------------------------------------ JSON shapes

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGid(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSeq),
    updated_at: isoOf(repo.updatedSeq),
  };
}

function isoOf(seq: number): string {
  return new Date((1735689600 + seq) * 1000).toISOString();
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbid,
    node_id: store.issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l !== undefined ? l.color : 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoOf(issue.createdSeq),
    updated_at: isoOf(issue.updatedSeq),
  };
}

/** Cached JSON body bytes for a single-issue GET (invalidated on any change to the issue). */
function issueBodyBytes(store: Store, repo: Repo, issue: Issue): Buffer {
  if (issue.cachedBuf === null) {
    issue.cachedBuf = Buffer.from(JSON.stringify(issueJson(store, repo, issue)) + '\n', 'utf8');
  }
  return issue.cachedBuf;
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.dbid,
    node_id: store.commentGid(repo, issue, comment),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoOf(comment.createdSeq),
    updated_at: isoOf(comment.createdSeq),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.dbid,
    node_id: store.pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoOf(pull.createdSeq),
    updated_at: isoOf(pull.updatedSeq),
  };
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) \+0000$/.exec(line);
  if (m === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(0) };
  return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ------------------------------------------------------------ helpers

function bodyObj(req: Req): Record<string, unknown> | null {
  const j = (req as Req & { json?: unknown }).json;
  if (j !== undefined && typeof j === 'object' && j !== null && !Array.isArray(j)) return j as Record<string, unknown>;
  return null;
}

function strField(body: Record<string, unknown> | null, key: string): string | undefined {
  if (body === null) return undefined;
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function intQuery(req: Req, key: string, fallback: number): number {
  const v = req.query.get(key);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Link header for a paginated list, built from the request's own Host. */
function linkHeader(req: Req, base: string, perPage: number, page: number, totalPages: number): string {
  const origin = `http://${req.host}`;
  const parts: string[] = [];
  const url = (p: number): string => `${origin}${base}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], req: Req, base: string): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, intQuery(req, 'per_page', 30)));
  const page = Math.max(1, intQuery(req, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: linkHeader(req, base, perPage, page, totalPages) };
}

// ------------------------------------------------------------ routing

/** Handle a REST request; returns null when the path is not under /api/v3. */
export function handleRest(store: Store, req: Req): Res | null {
  if (!req.path.startsWith('/api/v3')) return null;
  const rest = req.path.slice('/api/v3'.length);
  const seg = rest.split('/').filter((s) => s !== '');
  const method = req.method;

  // GET /api/v3/ (root) — trailing slash or not.
  if (seg.length === 0) {
    if (method !== 'GET') return jsonRes(405, { message: 'Method Not Allowed' });
    return jsonRes(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta') {
    if (method !== 'GET') return jsonRes(405, { message: 'Method Not Allowed' });
    return jsonRes(200, { installed_version: '3.14.0' });
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return jsonRes(405, { message: 'Method Not Allowed' });
      return jsonRes(200, userJson());
    }
    if (seg[1] === 'repos') {
      if (method === 'GET') {
        const { page, link } = paginate(store.repoList, req, '/api/v3/user/repos');
        return jsonRes(200, page.map((r) => repoJson(store, r)), { link });
      }
      if (method === 'POST') {
        const body = bodyObj(req);
        const name = strField(body, 'name');
        if (name === undefined || name === '') return unprocessable('name is required');
        const description = strField(body, 'description') ?? '';
        const isPrivate = body !== null && body['private'] === true;
        const repo = store.createRepo(name, description, isPrivate);
        if (repo === null) return unprocessable('Repository already exists');
        return jsonRes(201, repoJson(store, repo));
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const tail = seg.slice(3);

  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') return jsonRes(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const body = bodyObj(req);
      const description = strField(body, 'description');
      if (description !== undefined) repo.description = description;
      repo.updatedSeq = store.counter;
      return jsonRes(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return emptyRes(204);
    }
    return jsonRes(405, { message: 'Method Not Allowed' });
  }

  const sub = tail[0] as string;

  if (sub === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const list: Record<string, unknown>[] = [];
      for (const ref of [...repo.refs.keys()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } });
      }
      return jsonRes(200, list);
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (sha === undefined) return notFound();
      return jsonRes(200, { name: tail[1], commit: { sha } });
    }
    return notFound();
  }

  if (sub === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyObj(req);
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (ref === undefined || sha === undefined) return unprocessable('ref and sha are required');
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return unprocessable('Invalid ref');
      if (!repo.objects.has(sha)) return unprocessable('Invalid sha');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      repo.touch();
      return jsonRes(201, { ref, object: { sha } });
    }
    if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${tail[3]}`);
      if (sha === undefined) return notFound();
      return jsonRes(200, { ref: `refs/heads/${tail[3]}`, name: tail[3], object: { sha }, commit: { sha } });
    }
    return notFound();
  }

  if (sub === 'commits') {
    if (method !== 'GET') return jsonRes(405, { message: 'Method Not Allowed' });
    const ref = req.query.get('sha') ?? undefined;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) return jsonRes(200, []);
    const list = store.listCommits(repo, tip).map((sha) => {
      const obj = repo.objects.get(sha);
      let message = '';
      let author = { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(0) };
      let committer = author;
      if (obj !== undefined && obj.type === 'commit') {
        try {
          const c = parseCommit(obj.data);
          message = c.message;
          author = parseAuthorLine(c.author);
          committer = parseAuthorLine(c.committer);
        } catch {
          // keep defaults
        }
      }
      return { sha, commit: { message, author, committer } };
    });
    return jsonRes(200, list);
  }

  if (sub === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = req.query.get('ref') ?? undefined;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return notFound();
      const treeOid = repo.commitTree.get(tip);
      if (treeOid === undefined) return notFound();
      const flat = store.flattenTree(repo, treeOid);
      if (path === '') {
        return jsonRes(200, dirEntries(repo, treeOid, ''));
      }
      const file = flat.get(path);
      if (file !== undefined) {
        const obj = repo.objects.get(file.oid);
        const data = obj !== undefined ? obj.data : Buffer.alloc(0);
        return jsonRes(200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          sha: file.oid,
          size: data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      // Directory? A path is a directory when some file starts with path + '/'.
      let isDir = false;
      for (const p of flat.keys()) {
        if (p.startsWith(path + '/')) { isDir = true; break; }
      }
      if (!isDir) return notFound();
      return jsonRes(200, dirEntries(repo, treeOid, path));
    }
    if (method === 'PUT') {
      const body = bodyObj(req);
      const message = strField(body, 'message') ?? '';
      const contentB64 = strField(body, 'content');
      if (contentB64 === undefined) return unprocessable('content is required');
      const branch = strField(body, 'branch');
      const sha = strField(body, 'sha');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const result = store.putContents(repo, path, content, message, branch, sha);
      if ('error' in result) return jsonRes(result.error, { message: result.message });
      return jsonRes(result.isNew ? 201 : 200, {
        content: { sha: result.blobSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    }
    if (method === 'DELETE') {
      const body = bodyObj(req);
      const message = strField(body, 'message') ?? '';
      const branch = strField(body, 'branch');
      const result = store.deleteContents(repo, path, message, branch);
      if ('error' in result) return jsonRes(result.error, { message: result.message });
      return jsonRes(200, { commit: { sha: result.commitSha } });
    }
    return jsonRes(405, { message: 'Method Not Allowed' });
  }

  if (sub === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = bodyObj(req);
      const name = strField(body, 'name');
      if (name === undefined || name === '') return unprocessable('name is required');
      if (repo.labels.has(name)) return unprocessable('Label already exists');
      const color = strField(body, 'color') ?? 'ededed';
      repo.labels.set(name, { name, color });
      return jsonRes(201, { name, color });
    }
    if (method === 'GET' && tail.length === 1) {
      return jsonRes(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    return notFound();
  }

  if (sub === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = bodyObj(req);
        const title = strField(body, 'title');
        if (title === undefined) return unprocessable('title is required');
        const issueBody = strField(body, 'body') ?? '';
        const labelsRaw = body !== null ? body['labels'] : undefined;
        const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((x): x is string => typeof x === 'string') : [];
        const result = store.createIssue(repo, title, issueBody, labels);
        if ('error' in result) return jsonRes(result.error, { message: result.message });
        return jsonRes(201, issueJson(store, repo, result));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, link } = paginate(list, req, `/api/v3/repos/${owner}/${repoName}/issues`);
        return jsonRes(200, page.map((i) => issueJson(store, repo, i)), { link });
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    const num = Number(tail[1]);
    if (!Number.isSafeInteger(num) || num < 1) return notFound();
    const issue = repo.issueByNumber(num);
    if (issue === undefined) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') {
        // Fast path: cached JSON body bytes, zero stringify.
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': store.requestId() },
          body: issueBodyBytes(store, repo, issue),
        };
      }
      if (method === 'PATCH') {
        const body = bodyObj(req);
        const state = strField(body, 'state');
        if (state === 'closed' || state === 'open') issue.state = state;
        const title = strField(body, 'title');
        if (title !== undefined) issue.title = title;
        const issueBody = strField(body, 'body');
        if (issueBody !== undefined) issue.body = issueBody;
        issue.updatedSeq = store.counter;
        issue.cachedBuf = null;
        return jsonRes(200, issueJson(store, repo, issue));
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    if (tail[2] === 'comments') {
      if (method === 'POST') {
        const body = bodyObj(req);
        const commentBody = strField(body, 'body');
        if (commentBody === undefined) return unprocessable('body is required');
        const t = store.tick();
        void t;
        const comment: Comment = { dbid: store.nextCommentDbId++, body: commentBody, createdSeq: store.counter };
        issue.comments.push(comment);
        issue.updatedSeq = store.counter;
        issue.cachedBuf = null;
        return jsonRes(201, commentJson(store, repo, issue, comment));
      }
      if (method === 'GET') {
        return jsonRes(200, issue.comments.map((c) => commentJson(store, repo, issue, c)));
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    return notFound();
  }

  if (sub === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = bodyObj(req);
        const title = strField(body, 'title');
        const head = strField(body, 'head');
        const base = strField(body, 'base') ?? repo.defaultBranch;
        if (title === undefined || head === undefined) return unprocessable('title and head are required');
        const bodyText = strField(body, 'body') ?? '';
        const result = store.createPull(repo, title, bodyText, head, base);
        if ('error' in result) return jsonRes(result.error, { message: result.message });
        return jsonRes(201, pullJson(store, repo, result));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, link } = paginate(list, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
        return jsonRes(200, page.map((p) => pullJson(store, repo, p)), { link });
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    const num = Number(tail[1]);
    if (!Number.isSafeInteger(num) || num < 1) return notFound();
    const pull = repo.pullByNumber(num);
    if (pull === undefined) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') return jsonRes(200, pullJson(store, repo, pull));
      if (method === 'PATCH') {
        const body = bodyObj(req);
        const state = strField(body, 'state');
        if (state === 'closed' || state === 'open') pull.state = state;
        const title = strField(body, 'title');
        if (title !== undefined) pull.title = title;
        pull.updatedSeq = store.counter;
        return jsonRes(200, pullJson(store, repo, pull));
      }
      return jsonRes(405, { message: 'Method Not Allowed' });
    }
    if (tail[2] === 'files' && method === 'GET') {
      return jsonRes(200, store.pullFiles(repo, pull));
    }
    if (tail[2] === 'merge' && method === 'PUT') {
      const result = store.squashMerge(repo, pull);
      if ('error' in result) return jsonRes(result.error, { message: result.message });
      return jsonRes(200, { merged: true, sha: result.sha, message: `Pull request #${pull.number} successfully merged` });
    }
    return notFound();
  }

  return notFound();
}

/** Directory listing entries for `dirPath` inside a tree object. */
function dirEntries(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  // Walk to the subtree object for dirPath.
  let currentOid = treeOid;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const obj = repo.objects.get(currentOid);
      if (obj === undefined || obj.type !== 'tree') return [];
      let found: string | null = null;
      try {
        for (const e of parseTree(obj.data)) {
          if (e.name === part && e.mode === '40000') { found = e.oid; break; }
        }
      } catch {
        return [];
      }
      if (found === null) return [];
      currentOid = found;
    }
  }
  const obj = repo.objects.get(currentOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  try {
    for (const e of parseTree(obj.data)) {
      const path = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
      const isDir = e.mode === '40000';
      let size = 0;
      if (!isDir) {
        const blob = repo.objects.get(e.oid);
        size = blob !== undefined ? blob.data.length : 0;
      }
      out.push({ type: isDir ? 'dir' : 'file', name: e.name, path, sha: e.oid, size });
    }
  } catch {
    return [];
  }
  return out;
}
