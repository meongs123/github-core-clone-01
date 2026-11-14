// GraphQL v4: a small executor for the exact documents the suite sends (see
// spec/graphql-mcp-spec.md §2.21 — 18 documents, no directives, no named fragments).
// Hand-rolled parser + typed resolvers over the shared store. Unknown fields answer
// HTTP 200 with an errors array naming the field (the suite's one errors case).
import { jsonRes, type Req, type Res } from './http.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';
import { b64encode, b64decode } from './util.ts';

// ------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}():$![]=|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const raw = input.slice(i, j);
      tokens.push(raw.includes('.') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ------------------------------------------------------------ parser

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

export interface Selection {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selectionSet: Selection[] | null;
  fragmentType: string | null; // for inline fragments: the type condition
}

export interface Operation {
  op: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: GqlValue | null }[];
  selectionSet: Selection[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('graphql: unexpected end of document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`graphql: expected '${value}'`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('graphql: expected a name');
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === undefined) break;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ op: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const op = t.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nt = this.peek();
        if (nt !== undefined && nt.kind === 'name') name = this.next().value as string;
        const variables: Operation['variables'] = [];
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            const dollar = this.next();
            if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('graphql: expected $');
            const vname = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let def: GqlValue | null = null;
            if (this.acceptPunct('=')) def = this.parseValue();
            variables.push({ name: vname, defaultValue: def });
          }
        }
        ops.push({ op, name, variables, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error('graphql: unexpected token at document level');
    }
    return ops;
  }

  private parseType(): void {
    // Type references: Name, [Name], Name!, [Name!]! — consume and ignore.
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.acceptPunct('}')) {
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t !== undefined && t.kind === 'spread') {
      this.next();
      const nt = this.peek();
      if (nt !== undefined && nt.kind === 'name' && nt.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { alias: null, name: '', args: [], selectionSet: this.parseSelectionSet(), fragmentType: typeName };
      }
      throw new Error('graphql: named fragments are not supported');
    }
    let alias: string | null = null;
    let name = this.expectName();
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Selection['args'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const aname = this.expectName();
        this.expectPunct(':');
        args.push({ name: aname, value: this.parseValue() });
      }
    }
    let selectionSet: Selection[] | null = null;
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { alias, name, args, selectionSet, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('graphql: unexpected value token');
  }
}

// ------------------------------------------------------------ value resolution

type Vars = Record<string, unknown>;

function resolveValue(v: GqlValue, vars: Vars): unknown {
  switch (v.kind) {
    case 'variable': return vars[v.name];
    case 'string': return v.value;
    case 'int': return v.value;
    case 'float': return v.value;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argMap(sel: Selection, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = resolveValue(a.value, vars);
  return out;
}

// ------------------------------------------------------------ schema table (for validation + introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  PullRequestChangedFileConnection: ['nodes'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node'],
  DefaultBranchRef: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ------------------------------------------------------------ executor

interface ExecCtx {
  store: Store;
  vars: Vars;
  errors: { message: string }[];
}

type NodeValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; repo: Repo; pull: Pull; first?: number }
  | { __typename: 'CommentEdge'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'DefaultBranchRef'; name: string }
  | { __typename: '__Type'; name: string };

function typenameOf(v: NodeValue): string {
  return v.__typename;
}

/** Apply a selection set to an object node; unknown fields become errors + null. */
function executeSelection(ctx: ExecCtx, node: NodeValue, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typenameOf(node);
  const known = TYPE_FIELDS[typeName] ?? [];
  for (const sel of selections) {
    if (sel.fragmentType !== null) {
      // Inline fragment: applies only when the type matches.
      if (sel.fragmentType === typeName) {
        const inner = executeSelection(ctx, node, sel.selectionSet ?? []);
        for (const [k, v] of Object.entries(inner)) out[k] = v;
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (!known.includes(sel.name)) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = resolveField(ctx, node, sel);
  }
  return out;
}

function resolveField(ctx: ExecCtx, node: NodeValue, sel: Selection): unknown {
  const args = argMap(sel, ctx.vars);
  const store = ctx.store;
  switch (node.__typename) {
    case 'User': {
      return node.login;
    }
    case 'Repository': {
      const repo = node.repo;
      switch (sel.name) {
        case 'id': return store.repoGid(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return sel.selectionSet === null ? null : executeSelection(ctx, { __typename: 'User', login: repo.owner }, sel.selectionSet);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          const n: NodeValue = { __typename: 'DefaultBranchRef', name: repo.defaultBranch };
          return sel.selectionSet === null ? { name: repo.defaultBranch } : executeSelection(ctx, n, sel.selectionSet);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issueByNumber(Number(args['number']));
          if (issue === undefined) return null;
          const n: NodeValue = { __typename: 'Issue', repo, issue };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
        case 'issues': {
          const conn = issuesConnection(store, repo, args);
          const n: NodeValue = { __typename: 'IssueConnection', repo, issues: conn.nodes, pageInfo: conn.pageInfo };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
        case 'pullRequests': {
          const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
          const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const capped = first !== undefined ? pulls.slice(0, first) : pulls;
          const n: NodeValue = { __typename: 'PullRequestConnection', repo, pulls: capped };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
        case 'pullRequest': {
          const pull = repo.pullByNumber(Number(args['number']));
          if (pull === undefined) return null;
          const n: NodeValue = { __typename: 'PullRequest', repo, pull };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
      }
      return null;
    }
    case 'Issue': {
      const issue = node.issue;
      switch (sel.name) {
        case 'id': return store.issueGid(node.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
      }
      return null;
    }
    case 'IssueConnection': {
      if (sel.name === 'nodes') {
        return node.issues.map((issue) => {
          const n: NodeValue = { __typename: 'Issue', repo: node.repo, issue };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        });
      }
      if (sel.name === 'pageInfo') {
        const pi = node.pageInfo;
        if (sel.selectionSet === null) return pi;
        const out: Record<string, unknown> = {};
        for (const s of sel.selectionSet) {
          if (s.name === 'hasNextPage') out[s.alias ?? s.name] = pi.hasNextPage;
          else if (s.name === 'endCursor') out[s.alias ?? s.name] = pi.endCursor;
        }
        return out;
      }
      return null;
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (sel.name) {
        case 'id': return store.pullGid(node.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return store.mergeable(node.repo, pull);
        case 'files': {
          const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
          const n: NodeValue = { __typename: 'PullRequestChangedFileConnection', repo: node.repo, pull, first };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
      }
      return null;
    }
    case 'PullRequestConnection': {
      if (sel.name === 'nodes') {
        return node.pulls.map((pull) => {
          const n: NodeValue = { __typename: 'PullRequest', repo: node.repo, pull };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        });
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (sel.name === 'nodes') {
        const files = store.pullFiles(node.repo, node.pull);
        const capped = node.first !== undefined ? files.slice(0, node.first) : files;
        return capped.map((f) => {
          if (sel.selectionSet === null) return { path: f.filename };
          const out: Record<string, unknown> = {};
          for (const s of sel.selectionSet) {
            if (s.name === 'path') out[s.alias ?? s.name] = f.filename;
          }
          return out;
        });
      }
      return null;
    }
    case 'IssueComment': {
      if (sel.name === 'id') return b64encode(`IssueComment:${node.repo.id}:${node.issue.number}:${node.commentId}`);
      if (sel.name === 'body') return node.body;
      return null;
    }
    case 'CommentEdge': {
      if (sel.name === 'node') {
        const n: NodeValue = { __typename: 'IssueComment', repo: node.repo, issue: node.issue, commentId: node.commentId, body: node.body };
        return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
      }
      return null;
    }
    case 'DefaultBranchRef': {
      if (sel.name === 'name') return node.name;
      return null;
    }
    case '__Type': {
      if (sel.name === 'name') return node.name;
      if (sel.name === 'fields') {
        const fields = TYPE_FIELDS[node.name] ?? [];
        return fields.map((name) => ({ name }));
      }
      if (sel.name === 'enumValues') {
        const values = TYPE_ENUM_VALUES[node.name] ?? [];
        return values.map((name) => ({ name }));
      }
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------ root execution

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  void store;
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  // CREATED_AT DESC, number DESC tie-break (default order too).
  list.sort((a, b) => (b.createdSeq - a.createdSeq) || (b.number - a.number));
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const decoded = b64decode(after);
    if (decoded !== null) {
      try {
        const cursor = JSON.parse(decoded) as { seq: number; num: number };
        list = list.filter((i) => i.createdSeq < cursor.seq || (i.createdSeq === cursor.seq && i.number < cursor.num));
      } catch {
        // Bad cursor: ignore it (return from the start).
      }
    }
  }
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const endCursor = last !== undefined ? b64encode(JSON.stringify({ seq: last.createdSeq, num: last.number })) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

// ------------------------------------------------------------ root execution

function executeOperation(store: Store, op: Operation, variables: Vars): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecCtx = { store, vars: variables, errors: [] };
  const rootType = op.op === 'query' ? 'Query' : 'Mutation';
  const out: Record<string, unknown> = {};
  for (const sel of op.selectionSet) {
    const key = sel.alias ?? sel.name;
    if (rootType === 'Query') {
      out[key] = resolveRootQuery(ctx, sel);
    } else {
      out[key] = resolveRootMutation(ctx, sel);
    }
  }
  if (ctx.errors.length > 0) return { data: out, errors: ctx.errors };
  return { data: out };
}

function resolveRootQuery(ctx: ExecCtx, sel: Selection): unknown {
  const store = ctx.store;
  const args = argMap(sel, ctx.vars);
  switch (sel.name) {
    case 'viewer': {
      const n: NodeValue = { __typename: 'User', login: VIEWER_LOGIN };
      return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
    }
    case 'repository': {
      const owner = String(args['owner'] ?? '');
      const name = String(args['name'] ?? '');
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return null;
      const n: NodeValue = { __typename: 'Repository', repo };
      return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
    }
    case 'node': {
      const id = String(args['id'] ?? '');
      const d = store.decodeGid(id);
      if (d === null) return null;
      if (d.kind === 'Repository') {
        const repo = store.repoByGid(id);
        if (repo === null) return null;
        const n: NodeValue = { __typename: 'Repository', repo };
        return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
      }
      if (d.kind === 'Issue') {
        for (const repo of store.repoList) {
          if (repo.id !== d.repoId) continue;
          const issue = repo.issueByNumber(d.number);
          if (issue === undefined) return null;
          const n: NodeValue = { __typename: 'Issue', repo, issue };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
        return null;
      }
      if (d.kind === 'PullRequest') {
        for (const repo of store.repoList) {
          if (repo.id !== d.repoId) continue;
          const pull = repo.pullByNumber(d.number);
          if (pull === undefined) return null;
          const n: NodeValue = { __typename: 'PullRequest', repo, pull };
          return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
        }
        return null;
      }
      return null;
    }
    case '__type': {
      const name = String(args['name'] ?? '');
      if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
      const n: NodeValue = { __typename: '__Type', name };
      return sel.selectionSet === null ? n : executeSelection(ctx, n, sel.selectionSet);
    }
    default: {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type 'Query'` });
      return null;
    }
  }
}

function resolveRootMutation(ctx: ExecCtx, sel: Selection): unknown {
  const store = ctx.store;
  const args = argMap(sel, ctx.vars);
  const input = (args['input'] ?? {}) as Record<string, unknown>;
  const fail = (message: string): null => {
    ctx.errors.push({ message });
    return null;
  };
  switch (sel.name) {
    case 'createIssue': {
      const repo = store.repoByGid(String(input['repositoryId'] ?? ''));
      if (repo === null) return fail('repository not found');
      const result = store.createIssue(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
      if ('error' in result) return fail(result.message);
      const n: NodeValue = { __typename: 'Issue', repo, issue: result };
      const out: Record<string, unknown> = {};
      for (const s of sel.selectionSet ?? []) {
        if (s.name === 'issue') {
          out[s.alias ?? s.name] = s.selectionSet === null ? n : executeSelection(ctx, n, s.selectionSet);
        }
      }
      return out;
    }
    case 'closeIssue': {
      const d = store.decodeGid(String(input['issueId'] ?? ''));
      if (d === null || d.kind !== 'Issue') return fail('issue not found');
      for (const repo of store.repoList) {
        if (repo.id !== d.repoId) continue;
        const issue = repo.issueByNumber(d.number);
        if (issue === undefined) return fail('issue not found');
        issue.state = 'closed';
        issue.updatedSeq = store.counter;
        issue.cachedBuf = null;
        const n: NodeValue = { __typename: 'Issue', repo, issue };
        const out: Record<string, unknown> = {};
        for (const s of sel.selectionSet ?? []) {
          if (s.name === 'issue') out[s.alias ?? s.name] = s.selectionSet === null ? n : executeSelection(ctx, n, s.selectionSet);
        }
        return out;
      }
      return fail('issue not found');
    }
    case 'createPullRequest': {
      const repo = store.repoByGid(String(input['repositoryId'] ?? ''));
      if (repo === null) return fail('repository not found');
      const result = store.createPull(
        repo,
        String(input['title'] ?? ''),
        String(input['body'] ?? ''),
        String(input['headRefName'] ?? ''),
        String(input['baseRefName'] ?? ''),
      );
      if ('error' in result) return fail(result.message);
      const n: NodeValue = { __typename: 'PullRequest', repo, pull: result };
      const out: Record<string, unknown> = {};
      for (const s of sel.selectionSet ?? []) {
        if (s.name === 'pullRequest') out[s.alias ?? s.name] = s.selectionSet === null ? n : executeSelection(ctx, n, s.selectionSet);
      }
      return out;
    }
    case 'mergePullRequest': {
      const d = store.decodeGid(String(input['pullRequestId'] ?? ''));
      if (d === null || d.kind !== 'PullRequest') return fail('pull request not found');
      for (const repo of store.repoList) {
        if (repo.id !== d.repoId) continue;
        const pull = repo.pullByNumber(d.number);
        if (pull === undefined) return fail('pull request not found');
        const merged = store.squashMerge(repo, pull);
        if ('error' in merged) return fail(merged.message);
        const n: NodeValue = { __typename: 'PullRequest', repo, pull };
        const out: Record<string, unknown> = {};
        for (const s of sel.selectionSet ?? []) {
          if (s.name === 'pullRequest') out[s.alias ?? s.name] = s.selectionSet === null ? n : executeSelection(ctx, n, s.selectionSet);
        }
        return out;
      }
      return fail('pull request not found');
    }
    case 'addComment': {
      const d = store.decodeGid(String(input['subjectId'] ?? ''));
      if (d === null || d.kind !== 'Issue') return fail('issue not found');
      for (const repo of store.repoList) {
        if (repo.id !== d.repoId) continue;
        const issue = repo.issueByNumber(d.number);
        if (issue === undefined) return fail('issue not found');
        const t = store.tick();
        void t;
        const comment = { dbid: store.nextCommentDbId++, body: String(input['body'] ?? ''), createdSeq: store.counter };
        issue.comments.push(comment);
        issue.updatedSeq = store.counter;
        issue.cachedBuf = null;
        const edge: NodeValue = { __typename: 'CommentEdge', repo, issue, commentId: comment.dbid, body: comment.body };
        const out: Record<string, unknown> = {};
        for (const s of sel.selectionSet ?? []) {
          if (s.name === 'commentEdge') out[s.alias ?? s.name] = s.selectionSet === null ? edge : executeSelection(ctx, edge, s.selectionSet);
        }
        return out;
      }
      return fail('issue not found');
    }
    default: {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type 'Mutation'` });
      return null;
    }
  }
}

// ------------------------------------------------------------ HTTP entry

/** Handle POST /api/graphql; returns null for other paths. */
export function handleGraphql(store: Store, req: Req): Res | null {
  if (req.path !== '/api/graphql') return null;
  if (req.method !== 'POST') return jsonRes(405, { message: 'Method Not Allowed' });
  const body = (req as Req & { json?: unknown }).json;
  if (body === undefined) return jsonRes(400, { message: 'Request body must be JSON' });
  try {
    if (Array.isArray(body)) {
      const results = body.map((entry) => executeEntry(store, entry));
      return jsonRes(200, results);
    }
    return jsonRes(200, executeEntry(store, body));
  } catch (err) {
    return jsonRes(200, { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
  }
}

function executeEntry(store: Store, entry: unknown): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'operation must be an object' }] };
  }
  const e = entry as Record<string, unknown>;
  const query = e['query'];
  if (typeof query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
  const variables = (e['variables'] ?? {}) as Vars;
  const operationName = typeof e['operationName'] === 'string' ? e['operationName'] : null;
  const ops = new Parser(tokenize(query)).parseDocument();
  let op = ops[0];
  if (operationName !== null) {
    const found = ops.find((o) => o.name === operationName);
    if (found !== undefined) op = found;
  }
  if (op === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const vars: Vars = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue !== null) vars[v.name] = resolveValue(v.defaultValue, vars);
  }
  return executeOperation(store, op, vars);
}
