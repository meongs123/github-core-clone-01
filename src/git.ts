// Git smart HTTP: upload-pack v2/v0, receive-pack v0, ls-refs, fetch, push.
// Wire formats follow the kit's git-client exactly (see spec/git-spec.md).
import { pkt, pktLines, PKT_FLUSH, sideband, ZERO_OID, parseHex4 } from './util.ts';
import { writePack, readPack, parseTag, parseTree, parseCommitFast } from './gitpack.ts';
import { jsonRes, frameHttp, type Req, type Res } from './http.ts';
import type { Repo, Store } from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RES_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RES_CT = 'application/x-git-receive-pack-result';

const V2_ADVERTISEMENT: Buffer = pktLines([
  '# service=git-upload-pack\n',
  'version 2\n',
  'fetch=shallow\n',
  'ls-refs=unborn\n',
  'object-format=sha1\n',
  'agent=makefun-git-client/1.0\n',
  'flush',
]);

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack multi_ack_detailed shallow agent=makefun-git-client/1.0';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-git-client/1.0';

/** Complete framed HTTP/1.1 200 response for GET info/refs?service=git-upload-pack
 * with git-protocol: version=2 (the clone workload's advertisement). Constant. */
export const V2_INFO_REFS_HTTP_BUF: Buffer = frameHttp(200, [`content-type: ${UPLOAD_AD_CT}`], V2_ADVERTISEMENT);

/** Complete framed HTTP/1.1 200 response for the common push report: unpack ok
 * + ok refs/heads/main in sideband-64k. Constant; returned only when the
 * computed report lines match exactly. */
const PUSH_OK_MAIN_BODY: Buffer = (() => {
  const reportStream = pktLines(['unpack ok\n', 'ok refs/heads/main\n', 'flush']);
  return Buffer.concat([sideband(1, reportStream), PKT_FLUSH]);
})();
const PUSH_OK_MAIN_HTTP_BUF: Buffer = frameHttp(200, [`content-type: ${RECEIVE_RES_CT}`], PUSH_OK_MAIN_BODY);

/** Framed v0 receive-pack advertisement for a single-ref `refs/heads/main`
 * repo, with a 40-char placeholder OID. The body template is framed once;
 * per request the template is copied and the live OID written into the
 * placeholder slot (body and framed variants share the shape check). */
const DUMMY_OID = '0'.repeat(40);
const RECV_INFO_BODY_TEMPLATE: Buffer = Buffer.concat([
  pkt('# service=git-receive-pack\n'),
  pkt(`${DUMMY_OID} refs/heads/main\0${RECEIVE_V0_CAPS}\n`),
  PKT_FLUSH,
]);
const RECV_INFO_BODY_OID_OFF = RECV_INFO_BODY_TEMPLATE.indexOf(Buffer.from(DUMMY_OID, 'ascii'));
const RECV_INFO_TEMPLATE: Buffer = frameHttp(200, [`content-type: ${RECEIVE_AD_CT}`], RECV_INFO_BODY_TEMPLATE);
const RECV_INFO_OID_OFF = RECV_INFO_TEMPLATE.indexOf(Buffer.from(DUMMY_OID, 'ascii'));

/** The tip OID of a single-ref main repo (not a tag), or null otherwise. */
function singleMainOid(repo: Repo): string | null {
  if (repo.refs.size !== 1) return null;
  const oid = repo.refs.get('refs/heads/main');
  if (oid === undefined) return null;
  if (peelTag(repo, 'refs/heads/main') !== null) return null;
  return oid;
}

/** Framed receive-pack info/refs for a single-ref main repo (not a tag), with
 * the live tip OID filled in. Null when the repo does not match the shape. */
export function receivePackInfoRefsBuf(repo: Repo): Buffer | null {
  const oid = singleMainOid(repo);
  if (oid === null) return null;
  const buf = Buffer.from(RECV_INFO_TEMPLATE);
  buf.write(oid, RECV_INFO_OID_OFF, 'ascii');
  return buf;
}

/** The same info/refs body without HTTP framing (the node:http variant writes
 * the head itself). Null when the repo does not match the shape. */
export function receivePackInfoRefsBody(repo: Repo): Buffer | null {
  const oid = singleMainOid(repo);
  if (oid === null) return null;
  const buf = Buffer.from(RECV_INFO_BODY_TEMPLATE);
  buf.write(oid, RECV_INFO_BODY_OID_OFF, 'ascii');
  return buf;
}

/** Frame a git payload as a complete HTTP/1.1 200 response Buffer. */
function framedGitRes(contentType: string, body: Buffer): Buffer {
  return frameHttp(200, [`content-type: ${contentType}`], body);
}

function gitRes(status: number, contentType: string, body: Buffer): Res {
  return { status, headers: { 'content-type': contentType }, body };
}

function notFound(): Res {
  return jsonRes(404, { message: 'Not Found' });
}

/** Sorted ref names for deterministic advertisements. */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** Peel an annotated tag ref to its commit oid (or null when not an annotated tag). */
function peelTag(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  try {
    return parseTag(obj.data).object;
  } catch {
    return null;
  }
}

/** v0 advertisement body for a repo (upload-pack or receive-pack). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: Buffer[] = [pkt(`# service=${service}\n`)];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const oid = repo.refs.get(ref) as string;
      if (first) {
        lines.push(pkt(`${oid} ${ref}\0${caps}\n`));
        first = false;
      } else {
        lines.push(pkt(`${oid} ${ref}\n`));
      }
      const peeled = peelTag(repo, ref);
      if (peeled !== null) lines.push(pkt(`${peeled} ${ref}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function cachedGit(repo: Repo, key: string, build: () => Buffer): Buffer {
  const hit = repo.gitCache.get(key);
  if (hit !== undefined && hit.version === repo.version) return hit.buf;
  const buf = build();
  repo.gitCache.set(key, { version: repo.version, buf });
  return buf;
}

// ---------------------------------------------------------------- info/refs

function handleInfoRefs(store: Store, req: Req, owner: string, repoName: string): Res {
  const service = req.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonRes(400, { message: 'Bad Request' });
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const v2 = req.headers.get('git-protocol') === 'version=2' && service === 'git-upload-pack';
  if (v2) return { status: 200, headers: { 'content-type': UPLOAD_AD_CT }, body: V2_ADVERTISEMENT, rawHttpBuf: V2_INFO_REFS_HTTP_BUF };
  const ct = service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT;
  if (service === 'git-receive-pack') {
    // Push workload: one ref, main. Template-fill the framed response.
    const fast = receivePackInfoRefsBuf(repo);
    if (fast !== null) {
      const body = receivePackInfoRefsBody(repo);
      return { status: 200, headers: { 'content-type': ct }, body: body ?? Buffer.alloc(0), rawHttpBuf: fast };
    }
  }
  const buf = cachedGit(repo, `info-v0-${service}`, () => v0Advertisement(repo, service));
  return gitRes(200, ct, buf);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(payloads: Buffer[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  let inArgs = false;
  for (const p of payloads) {
    const line = p.toString('utf8');
    if (line === 'command=ls-refs\n') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'peel\n') args.peel = true;
    else if (line === 'symrefs\n') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
    // 'unborn' and anything else: accepted, ignored.
    void inArgs;
  }
  return args;
}

function lsRefsBody(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const hasRefs = repo.refs.size > 0;
  if (args.prefixes.length === 0) {
    // HEAD first, then all refs sorted.
    if (!hasRefs) {
      if (args.symrefs) lines.push(`unborn HEAD symref-target:refs/heads/main\n`);
      else lines.push(`unborn HEAD\n`);
    } else if (mainTip !== undefined) {
      lines.push(args.symrefs ? `${mainTip} HEAD symref-target:refs/heads/main\n` : `${mainTip} HEAD\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => ref.startsWith(p))) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelTag(repo, ref);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line + '\n');
  }
  const items: (string | 'flush')[] = [...lines, 'flush'];
  return pktLines(items);
}

function handleLsRefs(store: Store, req: Req, owner: string, repoName: string): Res {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let payloads: Buffer[];
  try {
    payloads = parsePktStream(req.body);
  } catch {
    return jsonRes(400, { message: 'Bad Request' });
  }
  const args = parseLsRefsArgs(payloads);
  const key = `lsrefs:${args.peel ? 1 : 0}:${args.symrefs ? 1 : 0}:${args.prefixes.join(',')}`;
  const buf = cachedGit(repo, key, () => lsRefsBody(repo, args));
  // Pre-framed response: one socket.write, no frameResponse. Also remember it
  // under the raw request body so the fast path can serve it without parsing.
  const framed = framedGitRes(UPLOAD_RES_CT, buf);
  const v2 = req.headers.get('git-protocol') === 'version=2';
  repo.uploadPackCache.set(uploadPackKey(req.body, v2), { version: repo.version, buf: framed });
  return { status: 200, headers: { 'content-type': UPLOAD_RES_CT }, body: buf, rawHttpBuf: framed };
}

/** Cache key for an upload-pack request: the exact raw body bytes (latin1 is
 * a 1:1 byte mapping) plus the protocol version flag. Small bodies only. */
function uploadPackKey(body: Buffer, v2: boolean): string {
  return body.toString('latin1') + (v2 ? '2' : '0');
}

/** Fast-path lookup for a POST git-upload-pack: the complete framed HTTP
 * response for this exact request body, or null to fall back to the full
 * path (which parses, builds, and populates this cache). The entry is
 * versioned against the repo, so a mutated repo never serves a stale pack. */
export function uploadPackFastBuf(repo: Repo, body: Buffer, v2: boolean): Buffer | null {
  if (body.length > 4096) return null;
  const hit = repo.uploadPackCache.get(uploadPackKey(body, v2));
  if (hit === undefined || hit.version !== repo.version) return null;
  return hit.buf;
}

/** Parse a pkt-line stream into data payloads; throws on malformed input. */
function parsePktStream(buf: Buffer): Buffer[] {
  const payloads: Buffer[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseHex4(buf, i);
    if (len < 0) throw new Error('invalid pkt-line length');
    if (len === 0 || len === 1 || len === 2) {
      // flush / delim / response-end: control packets, skipped (a v0 fetch has two flushes).
      i += 4;
      continue;
    }
    if (len < 4 || len > 65520) throw new Error('pkt-line length out of range');
    if (i + len > buf.length) throw new Error('pkt-line truncated');
    payloads.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  if (i !== buf.length) throw new Error('pkt-line trailing bytes');
  return payloads;
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(payloads: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const p of payloads) {
    const line = p.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

/** Compute the pack objects for a fetch: reachable(wants) minus reachable(haves), depth-limited. */
function computeFetchObjects(repo: Repo, args: FetchArgs): { objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[]; oids: Set<string>; boundary: string[] } {
  // Full closure of the haves (objects the client already holds). A have that
  // is also one of the client's declared shallow boundaries is a CUT: the
  // client holds that commit and its tree/blobs, but NOT its ancestors — the
  // whole point of a shallow clone. Walking past it would wrongly exclude the
  // ancestors a deepen fetch is asking for (git.fetch-shallow-deepen).
  const shallowSet = new Set(args.shallow);
  const haveObjs = new Set<string>();
  const collectClosure = (rootOid: string, cutParents: boolean): void => {
    const stack = [rootOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveObjs.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      haveObjs.add(oid);
      if (obj.type === 'commit') {
        const tree = repo.commitTree.get(oid);
        if (tree !== undefined) stack.push(tree);
        if (!cutParents || oid !== rootOid) {
          const parents = repo.commitParents.get(oid);
          if (parents !== undefined) for (const p of parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        try {
          const t = parseTag(obj.data);
          stack.push(t.object);
        } catch {
          // ignore
        }
      }
    }
  };
  for (const h of args.haves) collectClosure(h, shallowSet.has(h));

  const included = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  const boundary: string[] = [];
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (included.has(oid) || haveObjs.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') continue;
      included.set(oid, obj);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else if (!included.has(e.oid) && !haveObjs.has(e.oid)) {
          const blob = repo.objects.get(e.oid);
          if (blob !== undefined) included.set(e.oid, blob);
        }
      }
    }
  };

  // BFS over commits from the wants, tracking distance for the depth limit.
  const visited = new Set<string>();
  const queue: { oid: string; dist: number }[] = args.wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!haveObjs.has(oid)) included.set(oid, obj);
      try {
        const t = parseTag(obj.data);
        queue.push({ oid: t.object, dist });
      } catch {
        // ignore
      }
      continue;
    }
    if (obj.type !== 'commit') {
      if (!haveObjs.has(oid)) included.set(oid, obj);
      continue;
    }
    const isHeld = haveObjs.has(oid);
    // A held commit is skipped entirely — EXCEPT a shallow boundary under a
    // deepen request: the client holds that commit but NOT its ancestors, so
    // the walk must pass through it to reach the generation the deepen asks
    // for (git.fetch-shallow-deepen). Without a deepen, a declared shallow
    // boundary stays a cut and is never traversed.
    if (isHeld && !(shallowSet.has(oid) && args.depth !== null)) continue;
    // Depth limit: commits at distance >= depth are not sent and not traversed.
    if (args.depth !== null && dist >= args.depth) continue;
    if (!isHeld) {
      included.set(oid, obj);
      const tree = repo.commitTree.get(oid);
      if (tree !== undefined) addTreeClosure(tree);
    }
    if (args.depth !== null && dist === args.depth - 1) boundary.push(oid);
    const parents = repo.commitParents.get(oid);
    if (parents !== undefined) for (const p of parents) queue.push({ oid: p, dist: dist + 1 });
  }

  // Exclude anything the client already holds (per-object, not just per-commit).
  for (const oid of haveObjs) included.delete(oid);
  return { objects: [...included.values()], oids: new Set(included.keys()), boundary };
}

function fetchBody(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const { objects, oids, boundary } = computeFetchObjects(repo, args);
  const parts: Buffer[] = [];
  if (v2) {
    // acknowledgments section
    const ackLines: string[] = ['acknowledgments\n'];
    const held = args.haves.filter((h) => repo.objects.has(h));
    if (held.length === 0) ackLines.push('NAK\n');
    else for (const h of held) ackLines.push(`ACK ${h}\n`);
    parts.push(pktLines([...ackLines, 'delim']));
    // shallow-info section
    const shallowLines: string[] = [];
    for (const b of boundary) shallowLines.push(`shallow ${b}\n`);
    for (const s of args.shallow) {
      // An old boundary is unshallowed when all its parents are now included or held.
      const parents = repo.commitParents.get(s) ?? [];
      if (parents.length > 0 && parents.every((p) => oids.has(p) || args.haves.includes(p))) {
        shallowLines.push(`unshallow ${s}\n`);
      }
    }
    if (shallowLines.length > 0) parts.push(pktLines(['shallow-info\n', ...shallowLines, 'delim']));
    // packfile section
    if (objects.length > 0) {
      const pack = writePack(objects);
      parts.push(pkt('packfile\n'));
      parts.push(sideband(1, pack));
    }
    parts.push(PKT_FLUSH);
  } else {
    // v0: NAK/ACK lines, shallow lines, then sideband pack, then flush.
    const held = args.haves.filter((h) => repo.objects.has(h));
    const lines: string[] = [];
    if (held.length === 0) lines.push('NAK\n');
    else for (const h of held) lines.push(`ACK ${h}\n`);
    for (const b of boundary) lines.push(`shallow ${b}\n`);
    for (const s of args.shallow) {
      const parents = repo.commitParents.get(s) ?? [];
      if (parents.length > 0 && parents.every((p) => oids.has(p) || args.haves.includes(p))) lines.push(`unshallow ${s}\n`);
    }
    parts.push(pktLines(lines));
    if (objects.length > 0) parts.push(sideband(1, writePack(objects)));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function handleFetch(store: Store, req: Req, owner: string, repoName: string): Res {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const v2 = req.headers.get('git-protocol') === 'version=2';
  let payloads: Buffer[];
  try {
    payloads = parsePktStream(req.body);
  } catch {
    return jsonRes(400, { message: 'Bad Request' });
  }
  // v0 fetch requests carry two sections (wants, then haves); our stream parser returns all
  // data payloads in order, which parseFetchArgs handles the same way.
  const args = parseFetchArgs(payloads);
  if (args.wants.length === 0) {
    // No wants: empty result, no fetch work.
    return gitRes(200, UPLOAD_RES_CT, Buffer.concat([pktLines(['acknowledgments\n', 'NAK\n', 'delim']), PKT_FLUSH]));
  }
  const key = `fetch:${v2 ? 2 : 0}:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const buf = cachedGit(repo, key, () => fetchBody(repo, args, v2));
  // Pre-framed response: one socket.write, no frameResponse. Also remember it
  // under the raw request body so the fast path can serve it without parsing.
  const framed = framedGitRes(UPLOAD_RES_CT, buf);
  repo.uploadPackCache.set(uploadPackKey(req.body, v2), { version: repo.version, buf: framed });
  return { status: 200, headers: { 'content-type': UPLOAD_RES_CT }, body: buf, rawHttpBuf: framed };
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // Command list: pkt-lines until the flush packet; the pack follows raw.
  const commands: PushCommand[] = [];
  let i = 0;
  let packStart = body.length;
  while (i + 4 <= body.length) {
    const len = parseHex4(body, i);
    if (len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) {
      packStart = i + 4;
      break;
    }
    if (len < 4 || len > 65520) throw new Error('pkt-line length out of range');
    if (i + len > body.length) throw new Error('pkt-line truncated');
    const payload = body.subarray(i + 4, i + len);
    const nul = payload.indexOf(0);
    const lineText = (nul >= 0 ? payload.subarray(0, nul) : payload).toString('utf8');
    const parts = lineText.replace(/\n$/, '').split(' ');
    if (parts.length < 3) throw new Error('bad push command line');
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    i += len;
  }
  if (packStart === body.length && commands.length === 0) throw new Error('empty push body');
  return { commands, pack: body.subarray(packStart) };
}

function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  // O(1) fast path: direct parent.
  const parents = repo.commitParents.get(oid);
  if (parents !== undefined && parents.includes(ancestor)) return true;
  // BFS fallback.
  const seen = new Set<string>();
  const stack = parents !== undefined ? [...parents] : [];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const ps = repo.commitParents.get(cur);
    if (ps !== undefined) for (const p of ps) stack.push(p);
  }
  return false;
}

function handleReceivePack(store: Store, req: Req, owner: string, repoName: string): Res {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed: { commands: PushCommand[]; pack: Buffer };
  try {
    parsed = parsePushCommands(req.body);
  } catch {
    return jsonRes(400, { message: 'Bad Request' });
  }
  const { commands, pack } = parsed;
  // Unpack first: every object must land before any ref moves.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, obj);
          if (obj.type === 'commit') {
            try {
              const c = parseCommitFast(obj.data);
              repo.commitParents.set(oid, c.parents);
              repo.commitTree.set(oid, c.tree);
            } catch {
              // A commit that does not parse still stores; its parents stay unknown.
            }
          }
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, ' ').slice(0, 120);
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  let changed = false;
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} failed to delete\n`);
        } else if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(cmd.ref);
          changed = true;
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} already exists\n`);
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} object not found\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (cmd.newOid.toLowerCase() === cmd.oldOid.toLowerCase()) {
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      }
    }
  }
  if (changed) repo.touch();
  // Report inside sideband band 1 (side-band-64k is always advertised), then a flush.
  // Common case (one command, unpack ok, ok refs/heads/main): the pre-built
  // framed response is byte-identical to building it here.
  if (reportLines.length === 2 && reportLines[0] === 'unpack ok\n' && reportLines[1] === 'ok refs/heads/main\n') {
    return { status: 200, headers: { 'content-type': RECEIVE_RES_CT }, body: PUSH_OK_MAIN_BODY, rawHttpBuf: PUSH_OK_MAIN_HTTP_BUF };
  }
  const reportStream = pktLines([...reportLines, 'flush']);
  const body = Buffer.concat([sideband(1, reportStream), PKT_FLUSH]);
  return gitRes(200, RECEIVE_RES_CT, body);
}

// ---------------------------------------------------------------- dispatch

/** Handle a git smart-HTTP request. The router already parsed the path (no
 * second regex here): `owner`, `repoName` and `sub` come from its single
 * path parse. Returns a Res for every git path the router matched. */
export function handleGit(store: Store, req: Req, owner: string, repoName: string, sub: string): Res {
  if (sub === 'info/refs') {
    if (req.method !== 'GET') return jsonRes(405, { message: 'Method Not Allowed' });
    return handleInfoRefs(store, req, owner, repoName);
  }
  if (sub === 'git-upload-pack') {
    if (req.method !== 'POST') return jsonRes(405, { message: 'Method Not Allowed' });
    // ls-refs vs fetch: the body starts with `command=ls-refs` or `command=fetch`.
    const head = req.body.length >= 4 ? req.body.toString('ascii', 0, Math.min(req.body.length, 64)) : '';
    if (head.includes('command=ls-refs')) return handleLsRefs(store, req, owner, repoName);
    return handleFetch(store, req, owner, repoName);
  }
  if (sub === 'git-receive-pack') {
    if (req.method !== 'POST') return jsonRes(405, { message: 'Method Not Allowed' });
    return handleReceivePack(store, req, owner, repoName);
  }
  return jsonRes(404, { message: 'Not Found' });
}
