// Git object model: hashing, tree/commit/tag build & parse, packfile read/write.
// The client sends plain objects only (no deltas); our packs are plain objects too.
// Pack reading supports OFS/REF deltas in the header parse but rejects them — they never occur.
import { hashObject, sha1Hex, inflateSync, deflateSync, treeSortKey } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Build a tree object from entries [{mode, name, oid}]; returns the raw tree bytes. */
export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.name, a.mode === '40000');
    const kb = treeSortKey(b.name, b.mode === '40000');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) throw new Error('tree-parse: missing space');
    const mode = data.toString('ascii', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) throw new Error('tree-parse: missing NUL');
    const name = data.toString('utf8', sp + 1, nul);
    if (nul + 21 > data.length) throw new Error('tree-parse: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-9a-f]+$/.test(mode)) throw new Error('tree-parse: bad mode');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

/** Parse a commit object. Headers are ASCII lines up to the first blank line. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const rawMessage = blank >= 0 ? text.slice(blank + 2) : '';
  // GitHub's API returns the message without the single trailing newline that
  // buildCommit appends to the stored bytes; strip exactly one.
  const message = rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage;
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('commit has no valid tree header');
  for (const p of parents) if (!/^[0-9a-f]{40}$/.test(p)) throw new Error('commit has a bad parent id');
  return { tree, parents, message, author, committer };
}

/** Build a commit object. Message is ensured to end with '\n'. */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const msg = opts.message.endsWith('\n') ? opts.message : opts.message + '\n';
  let head = `tree ${opts.tree}\n`;
  for (const p of opts.parents) head += `parent ${p}\n`;
  head += `author ${opts.author}\ncommitter ${opts.committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(msg, 'utf8')]);
}

/** Parse a tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (!/^[0-9a-f]{40}$/.test(object)) throw new Error('tag has no valid object');
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

/** Encode the type/size varint header for one pack entry. */
function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let b0 = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) b0 |= 0x80;
  bytes.push(b0);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack of plain (non-delta) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Read a packfile. Returns objects keyed by oid. Verifies the trailer checksum. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack-truncated');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack: bad magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const computed = Buffer.from(sha1Hex(pack.subarray(0, pack.length - 20)), 'hex');
  if (!trailer.equals(computed)) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  let off = 12;
  const end = pack.length - 20;
  for (let n = 0; n < count; n += 1) {
    if (off >= end) throw new Error('pack-truncated');
    // varint: first byte low nibble = size bits 0-3, bits 4-6 = type, bit 7 = continue.
    let b = pack[off++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (off >= end) throw new Error('pack-truncated');
      b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (shift > 63) throw new Error('pack-corrupt');
    }
    if (typeCode === 6 || typeCode === 7) {
      // Deltas are never sent by this suite's client; reject rather than mis-resolve.
      throw new Error('pack entry is a delta (unsupported here)');
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    // Inflate from off; inflateSync with info:true exposes engine.bytesWritten, which is
    // exactly the number of compressed input bytes consumed (verified empirically).
    const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = inflated.engine.bytesWritten;
    if (consumed <= 0) throw new Error('pack-zlib: could not measure compressed length');
    const data: Buffer = inflated.buffer as Buffer;
    if (data.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${data.length}`);
    off += consumed;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
  }
  if (off !== end) throw new Error(`pack has ${end - off} stray bytes before its trailer`);
  if (objects.size !== count) throw new Error('pack has duplicate resolved oids');
  return objects;
}
