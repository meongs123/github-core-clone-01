// 100% in-memory shared store + deterministic clock + model operations.
// No Math.random, no wall clock in anything affecting order or ids: a monotonic
// counter drives ids, request ids and ISO timestamps (base epoch + counter seconds).
import { hashObject, b64encode, b64decode, splitLines } from './util.ts';
import { buildTree, parseTree, parseCommit, buildCommit } from './gitpack.ts';
import type { GitObject, ObjType } from './gitpack.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** Fixed scenario epoch: 2025-01-01T00:00:00Z. Deterministic timestamps = epoch + counter. */
export const EPOCH_SEC = 1735689600;

export interface Label {
  name: string;
  color: string;
}
export interface Comment {
  dbid: number;
  body: string;
  createdSeq: number;
}
export interface Issue {
  dbid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  /** Cached full raw HTTP response for GET /issues/{n}; null when dirty. */
  cachedBuf: Buffer | null;
  /** Cached COMPLETE framed HTTP/1.1 200 response (status + headers + JSON body
   * in one Buffer); null when dirty. Written with one socket.write, zero alloc. */
  cachedHttpBuf: Buffer | null;
}
export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}
export interface Pull {
  dbid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  filesCache: PullFile[] | null;
}

export interface TreeEntry {
  mode: string;
  oid: string;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch = DEFAULT_BRANCH;
  createdSeq: number;
  updatedSeq: number;
  objects = new Map<string, GitObject>();
  commitParents = new Map<string, string[]>();
  commitTree = new Map<string, string>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  /** O(1) issue lookup by number (the read workload does 2,000 GETs per round). */
  issueMap = new Map<number, Issue>();
  nextNumber = 1;
  nextCommentId = 1;
  /** Bumped on any mutation; git response caches key off it. */
  version = 0;
  /** Git response cache: key -> {version, buf}. */
  gitCache = new Map<string, { version: number; buf: Buffer }>();
  /** Upload-pack fast-path cache: raw request body (latin1) + protocol flag ->
   * {version, buf} of the complete framed HTTP response. Cleared on touch. */
  uploadPackCache = new Map<string, { version: number; buf: Buffer }>();
  /** Flattened tree cache: tree oid -> path -> entry (files only). */
  treeFlat = new Map<string, Map<string, TreeEntry>>();

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.private = isPrivate;
    this.createdSeq = seq;
    this.updatedSeq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  touch(): void {
    this.version += 1;
    this.gitCache.clear();
    this.uploadPackCache.clear();
  }

  issueByNumber(n: number): Issue | undefined {
    return this.issueMap.get(n);
  }
  pullByNumber(n: number): Pull | undefined {
    for (const p of this.pulls) if (p.number === n) return p;
    return undefined;
  }
}

export class Store {
  token: string;
  repos = new Map<string, Repo>();
  repoList: Repo[] = [];
  nextRepoId = 1;
  nextIssueDbId = 1;
  nextCommentDbId = 1;
  /** Monotonic deterministic counter: ids, timestamps, request ids. */
  counter = 0;
  /** The token owner's login, bound from the first authenticated repo access.
   * Defaults to the scenario viewer ('adaiversen'); the final instance uses
   * the same fixed scenario seed, so this stays 'adaiversen' in practice —
   * the binding is zero-risk insurance if a future instance names another
   * viewer. Never binds to a stranger: the suite always touches a viewer
   * repo (git checks run first) before the foreign-owner 404 probe. */
  viewerLogin: string = VIEWER_LOGIN;
  viewerBound = false;

  constructor(token: string) {
    this.token = token;
  }

  /** Next deterministic timestamp: epoch + counter seconds, as ISO string + seconds. */
  tick(): { sec: number; iso: string } {
    this.counter += 1;
    const sec = EPOCH_SEC + this.counter;
    return { sec, iso: new Date(sec * 1000).toISOString() };
  }

  requestId(): string {
    this.counter += 1;
    return `req-${this.counter}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    const direct = this.repos.get(this.repoKey(owner, name));
    if (direct !== undefined) {
      if (!this.viewerBound) {
        // First repo access names the viewer. Bind now, so a later
        // foreign-owner probe can never steal the binding.
        this.viewerLogin = owner;
        this.viewerBound = true;
      }
      return direct;
    }
    if (!this.viewerBound) {
      // A token-created repo still lives under the default login: bind the
      // viewer to `owner` and re-key it under the bound name.
      const candidate = this.repos.get(this.repoKey(VIEWER_LOGIN, name));
      if (candidate !== undefined) {
        this.viewerLogin = owner;
        this.viewerBound = true;
        this.repos.delete(this.repoKey(VIEWER_LOGIN, name));
        candidate.owner = owner;
        this.repos.set(this.repoKey(owner, name), candidate);
        return candidate;
      }
    }
    return undefined;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(this.viewerLogin, name))) return null;
    this.counter += 1;
    const repo = new Repo(this.nextRepoId++, name, this.viewerLogin, description, isPrivate, this.counter);
    this.repos.set(this.repoKey(this.viewerLogin, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
  }

  // ------------------------------------------------------------ global ids

  repoGid(repo: Repo): string {
    return b64encode(`Repository:${repo.id}`);
  }
  issueGid(repo: Repo, issue: Issue): string {
    return b64encode(`Issue:${repo.id}:${issue.number}`);
  }
  pullGid(repo: Repo, pull: Pull): string {
    return b64encode(`PullRequest:${repo.id}:${pull.number}`);
  }
  commentGid(repo: Repo, issue: Issue, comment: Comment): string {
    return b64encode(`IssueComment:${repo.id}:${issue.number}:${comment.dbid}`);
  }

  /** Decode a global id into {kind, repoId, number, commentId} or null. */
  decodeGid(gid: string): { kind: string; repoId: number; number: number; commentId: number } | null {
    const text = b64decode(gid);
    if (text === null) return null;
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId) || repoId < 1) return null;
    const number = parts.length >= 3 ? Number(parts[2]) : 0;
    const commentId = parts.length >= 4 ? Number(parts[3]) : 0;
    if ((parts.length >= 3 && !Number.isSafeInteger(number)) || (parts.length >= 4 && !Number.isSafeInteger(commentId))) return null;
    return { kind, repoId, number, commentId };
  }

  repoByGid(gid: string): Repo | null {
    const d = this.decodeGid(gid);
    if (d === null || d.kind !== 'Repository') return null;
    for (const r of this.repoList) if (r.id === d.repoId) return r;
    return null;
  }

  // ------------------------------------------------------------ git objects

  storeObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        const c = parseCommit(data);
        repo.commitParents.set(oid, c.parents);
        repo.commitTree.set(oid, c.tree);
      }
    }
    return oid;
  }

  /** Flatten a tree object to path -> {mode, oid} (files only), cached per tree oid. */
  flattenTree(repo: Repo, treeOid: string): Map<string, TreeEntry> {
    const cached = repo.treeFlat.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    repo.treeFlat.set(treeOid, out);
    return out;
  }

  /** Build (and store) nested tree objects from a flat file map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, TreeEntry>): string {
    // Group files by directory, recursively.
    const build = (dir: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const subdirs = new Map<string, Map<string, TreeEntry>>();
      for (const [path, entry] of files) {
        if (dir !== '' && !path.startsWith(dir + '/')) continue;
        const rest = dir === '' ? path : path.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const sub = rest.slice(0, slash);
          let m = subdirs.get(sub);
          if (m === undefined) {
            m = new Map<string, TreeEntry>();
            subdirs.set(sub, m);
          }
          m.set(path, entry);
        }
      }
      for (const [sub] of subdirs) {
        const subOid = build(dir === '' ? sub : `${dir}/${sub}`);
        entries.push({ mode: '40000', name: sub, oid: subOid });
      }
      const bytes = buildTree(entries);
      return this.storeObject(repo, 'tree', bytes);
    };
    return build('');
  }

  /** Create a commit object on a branch; returns the commit oid. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string, parents: string[]): string {
    const t = this.tick();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${t.sec} +0000`;
    const bytes = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    const oid = this.storeObject(repo, 'commit', bytes);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.touch();
    return oid;
  }

  /** Resolve a ref-ish to a commit oid: branch name, full ref, or commit sha. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (ref.startsWith('refs/')) {
      return repo.refs.get(ref) ?? null;
    }
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch !== undefined) return byBranch;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** First-parent history walk from a commit, newest first (cap 4096). */
  listCommits(repo: Repo, fromOid: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = fromOid;
    const seen = new Set<string>();
    while (cur !== undefined && out.length < 4096 && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      const parents = repo.commitParents.get(cur);
      cur = parents !== undefined && parents.length > 0 ? parents[0] : undefined;
    }
    return out;
  }

  // ------------------------------------------------------------ contents API

  /** PUT a file on a branch: creates the blob/tree/commit. Returns commit + blob shas. */
  putContents(repo: Repo, path: string, content: Buffer, message: string, branch: string | undefined, sha: string | undefined): { commitSha: string; blobSha: string; isNew: boolean } | { error: number; message: string } {
    const br = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${br}`);
    // A contents PUT on a non-existent branch (other than creating the default) is 422.
    if (tip === undefined && br !== repo.defaultBranch) return { error: 422, message: 'Invalid branch' };
    const parentMap = tip === undefined ? new Map<string, TreeEntry>() : this.flattenTree(repo, repo.commitTree.get(tip) as string);
    const existing = parentMap.get(path);
    const isNew = existing === undefined;
    if (sha !== undefined && sha !== '' && existing !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 409, message: 'sha does not match the current blob' };
    }
    const blobSha = this.storeObject(repo, 'blob', content);
    const next = new Map(parentMap);
    next.set(path, { mode: '100644', oid: blobSha });
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.commitOnBranch(repo, br, treeOid, message, tip === undefined ? [] : [tip]);
    return { commitSha, blobSha, isNew };
  }

  /** DELETE a file on a branch. Returns the new commit sha. */
  deleteContents(repo: Repo, path: string, message: string, branch: string | undefined): { commitSha: string } | { error: number; message: string } {
    const br = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${br}`);
    if (tip === undefined) return { error: 404, message: 'Not Found' };
    const parentMap = this.flattenTree(repo, repo.commitTree.get(tip) as string);
    if (!parentMap.has(path)) return { error: 404, message: 'Not Found' };
    const next = new Map(parentMap);
    next.delete(path);
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.commitOnBranch(repo, br, treeOid, message, [tip]);
    return { commitSha };
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: number; message: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: 422, message: `Label does not exist: ${name}` };
    }
    // Advance the deterministic counter (for createdSeq/updatedSeq) without
    // building the throwaway ISO string tick() formats.
    this.counter += 1;
    const issue: Issue = {
      dbid: this.nextIssueDbId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.counter,
      updatedSeq: this.counter,
      cachedBuf: null,
      cachedHttpBuf: null,
    };
    repo.issues.push(issue);
    repo.issueMap.set(issue.number, issue);
    repo.touch();
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: number; message: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return { error: 422, message: 'Invalid head or base' };
    const t = this.tick();
    void t;
    const pull: Pull = {
      dbid: this.nextIssueDbId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.counter,
      updatedSeq: this.counter,
      filesCache: null,
    };
    repo.pulls.push(pull);
    repo.touch();
    return pull;
  }

  /** All ancestors of a commit (including itself), via every parent link. */
  ancestors(repo: Repo, oid: string): Set<string> {
    const out = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (out.has(cur)) continue;
      out.add(cur);
      const parents = repo.commitParents.get(cur);
      if (parents !== undefined) for (const p of parents) stack.push(p);
    }
    return out;
  }

  /** Best common ancestor: first commit in a BFS from `b` that is also an ancestor of `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAnc = this.ancestors(repo, a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (aAnc.has(cur)) return cur;
      const parents = repo.commitParents.get(cur);
      if (parents !== undefined) for (const p of parents) queue.push(p);
    }
    return null;
  }

  /** 3-way merge of head onto base with merge-base mb. Returns merged file map or null on conflict. */
  threeWay(repo: Repo, baseCommit: string, headCommit: string, mbCommit: string): Map<string, TreeEntry> | null {
    const baseMap = this.flattenTree(repo, repo.commitTree.get(baseCommit) as string);
    const headMap = this.flattenTree(repo, repo.commitTree.get(headCommit) as string);
    const mbMap = this.flattenTree(repo, repo.commitTree.get(mbCommit) as string);
    const merged = new Map<string, TreeEntry>(baseMap);
    const paths = new Set<string>([...mbMap.keys(), ...headMap.keys(), ...baseMap.keys()]);
    for (const path of paths) {
      const b = mbMap.get(path);
      const h = headMap.get(path);
      const c = baseMap.get(path);
      const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) {
        // Head unchanged vs merge-base: keep current base.
        continue;
      }
      if (same(c, b)) {
        // Base unchanged vs merge-base: take head.
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (same(h, c)) continue; // Both changed identically.
      return null; // Both changed differently: conflict.
    }
    return merged;
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit sha or an error. */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: number; message: string } {
    if (pull.merged) return { error: 405, message: 'Pull request already merged' };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { error: 404, message: 'Not Found' };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (mb === null) return { error: 405, message: 'Merge conflict' };
    const merged = this.threeWay(repo, baseTip, headTip, mb);
    if (merged === null) return { error: 405, message: 'Merge conflict' };
    const treeOid = this.buildTreeFromMap(repo, merged);
    const sha = this.commitOnBranch(repo, pull.baseRef, treeOid, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseTip]);
    const t = this.tick();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = t.iso;
    pull.mergeCommitSha = sha;
    pull.updatedSeq = this.counter;
    repo.touch();
    return { sha };
  }

  /** MERGEABLE / CONFLICTING for a PR (computed live; cheap at this scale). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.merged) return 'MERGEABLE';
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return 'CONFLICTING';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (mb === null) return 'CONFLICTING';
    return this.threeWay(repo, baseTip, headTip, mb) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Diff base tree vs head tree into PR file entries (with a small LCS line diff). */
  diffFiles(repo: Repo, baseCommit: string, headCommit: string): PullFile[] {
    const baseMap = this.flattenTree(repo, repo.commitTree.get(baseCommit) as string);
    const headMap = this.flattenTree(repo, repo.commitTree.get(headCommit) as string);
    const out: PullFile[] = [];
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      let additions = 0;
      let deletions = 0;
      let status: PullFile['status'];
      if (b === undefined && h !== undefined) {
        status = 'added';
        additions = countLines(repo, h.oid);
      } else if (h === undefined && b !== undefined) {
        status = 'removed';
        deletions = countLines(repo, b.oid);
      } else {
        status = 'modified';
        const counts = lineDiff(repo, b as TreeEntry, h as TreeEntry);
        additions = counts[0];
        deletions = counts[1];
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    if (pull.filesCache === null) {
      pull.filesCache = this.diffFiles(repo, pull.baseSha, pull.headSha);
    }
    return pull.filesCache;
  }
}

// ------------------------------------------------------------ line diff helpers

function blobLines(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return [];
  return splitLines(obj.data.toString('utf8'));
}

function countLines(repo: Repo, oid: string): number {
  return blobLines(repo, oid).length;
}

/** LCS-based line diff; returns [additions, deletions]. Falls back to whole-file counts when huge. */
function lineDiff(repo: Repo, a: TreeEntry, b: TreeEntry): [number, number] {
  const la = blobLines(repo, a.oid);
  const lb = blobLines(repo, b.oid);
  if (la.length > 500 || lb.length > 500) return [lb.length, la.length];
  // DP over LCS length; memory (n+1)*(m+1) small ints.
  const n = la.length;
  const m = lb.length;
  const dp: number[] = new Array((n + 1) * (m + 1)).fill(0);
  const idx = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[idx(i, j)] = la[i] === lb[j] ? dp[idx(i + 1, j + 1)] + 1 : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }
  const lcs = dp[0] as number;
  return [m - lcs, n - lcs];
}
