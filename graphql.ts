// GraphQL v4: a small parser and executor for the documents the suite sends
// (queries, mutations, inline fragments, variables, batch arrays, and the
// __type/__schema introspection the checks read). No dependency, no network.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  branchTip,
  getRepo,
  nextGlobalId,
  nextTs,
  tsIso,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  pullFiles,
  pullMergeable,
  sendJson,
} from './rest.ts';

// ---------------------------------------------------------------- global ids

/** Opaque, stable ids: base64 of `Kind:owner/repo:number...` (never the raw id). */
export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

export function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', `${repo.owner}/${repo.name}`);
}
function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.owner}/${repo.name}`, issue.number);
}
function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.owner}/${repo.name}`, pull.number);
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}
function indexOfCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const value = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: value.replace(/\\"""/g, '"""') });
        i = end < 0 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          const esc = input[j + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(input[j]!)) j += 1;
      }
      const raw = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(raw) } : { kind: 'int', value: parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationDef {
  kind: 'operation';
  op: 'query' | 'mutation';
  name?: string;
  varDefs: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type Definition = OperationDef | FragmentDef;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private matchPunct(value: string): boolean {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return tok.value;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.pos < this.tokens.length) defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): Definition {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '{') return this.parseOperation('query');
    if (tok?.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      this.next();
      return this.parseOperation(tok.value);
    }
    if (tok?.kind === 'name' && tok.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected "on" in fragment definition');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error('expected an operation or fragment in GraphQL document');
  }

  private parseOperation(op: 'query' | 'mutation'): OperationDef {
    let name: string | undefined;
    const tok = this.peek();
    if (tok?.kind === 'name') {
      name = this.next().value;
    }
    const varDefs: OperationDef['varDefs'] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.matchPunct('=')) defaultValue = this.parseValue();
        varDefs.push({ name: varName, type, defaultValue });
      }
    }
    return { kind: 'operation', op, name, varDefs, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): string {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.matchPunct('!')) out += '!';
      return out;
    }
    if (tok.kind !== 'name') throw new Error('expected a type name in GraphQL document');
    let out = tok.value;
    if (this.matchPunct('!')) out += '!';
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@include/@skip): parse and ignore.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'float') return { kind: 'float', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('expected a value in GraphQL document');
  }
}

// ---------------------------------------------------------------- schema (introspection)

interface TypeField {
  name: string;
  type: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: TypeField[];
  enumValues?: string[];
  inputFields?: TypeField[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  Node: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID!' }] },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'login', type: 'String!' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String!' },
      { name: 'nameWithOwner', type: 'String!' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean!' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
    ],
  },
  Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String!' }] },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'state', type: 'IssueState!' },
      { name: 'body', type: 'String' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[Issue!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'number', type: 'Int!' },
      { name: 'state', type: 'PullRequestState!' },
      { name: 'merged', type: 'Boolean!' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState!' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequest!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequestChangedFile!]' },
      { name: 'pageInfo', type: 'PageInfo!' },
      { name: 'totalCount', type: 'Int!' },
    ],
  },
  PullRequestChangedFile: { kind: 'OBJECT', fields: [{ name: 'path', type: 'String!' }] },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'body', type: 'String!' },
    ],
  },
  CommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }] },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean!' },
      { name: 'hasPreviousPage', type: 'Boolean!' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'CommentEdge' }] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TOPIC', 'WIKI'],
  },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  ID: { kind: 'SCALAR' },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [{ name: 'issueId', type: 'ID!' }],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'String' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
    ],
  },
};

function introspectionType(typeStr: string): Record<string, unknown> {
  if (typeStr.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: introspectionType(typeStr.slice(0, -1)) };
  if (typeStr.startsWith('[') && typeStr.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: introspectionType(typeStr.slice(1, -1)) };
  }
  const def = SCHEMA[typeStr];
  const kind = def?.kind ?? 'SCALAR';
  return { kind, name: typeStr, ofType: null };
}

function typeDescriptor(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const out: Record<string, unknown> = { kind: def.kind, name, description: null };
  if (def.kind === 'OBJECT' || def.kind === 'INPUT_OBJECT') {
    out.fields = (def.fields ?? []).map((f) => ({
      name: f.name,
      description: null,
      args: [],
      type: introspectionType(f.type),
      isDeprecated: false,
      deprecationReason: null,
    }));
    out.inputFields = (def.inputFields ?? []).map((f) => ({
      name: f.name,
      description: null,
      type: introspectionType(f.type),
      defaultValue: null,
    }));
    out.enumValues = null;
  } else if (def.kind === 'ENUM') {
    out.fields = null;
    out.inputFields = null;
    out.enumValues = (def.enumValues ?? []).map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
  } else {
    out.fields = null;
    out.inputFields = null;
    out.enumValues = null;
  }
  return out;
}

// ---------------------------------------------------------------- executor

class GqlError extends Error {}

interface Wrapped {
  __typename: string;
  value: unknown;
}

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function wrap(typename: string, value: unknown): Wrapped {
  return { __typename: typename, value };
}

function repoWrap(repo: Repo): Wrapped {
  return wrap('Repository', repo);
}
function issueWrap(repo: Repo, issue: Issue): Wrapped {
  return wrap('Issue', { repo, issue });
}
function pullWrap(repo: Repo, pull: Pull): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function evalArgs(args: FieldNode['args'], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function repoFromGid(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return null;
  const full = decoded.parts[0]!;
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  return getRepo(full.slice(0, slash), full.slice(slash + 1));
}

function issueFromGid(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return null;
  const full = decoded.parts[0]!;
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  const repo = getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === parseInt(decoded.parts[1]!, 10));
  return issue ? { repo, issue } : null;
}

function pullFromGid(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return null;
  const full = decoded.parts[0]!;
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  const repo = getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === parseInt(decoded.parts[1]!, 10));
  return pull ? { repo, pull } : null;
}

function pageInfoFor(total: number, start: number, end: number): Wrapped {
  return wrap('PageInfo', {
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: end > start ? cursorOf(start) : null,
    endCursor: end > start ? cursorOf(end - 1) : null,
  });
}

function connectionOf<T>(nodes: T[], args: Record<string, unknown>, nodeTypename: string, connTypename: string): Wrapped {
  const after = typeof args.after === 'string' ? indexOfCursor(args.after) : -1;
  const first = typeof args.first === 'number' ? args.first : null;
  const start = after + 1;
  const end = first !== null ? Math.min(nodes.length, start + first) : nodes.length;
  const page = nodes.slice(start, end).map((n) => wrap(nodeTypename, n));
  return wrap(connTypename, { nodes: page, pageInfo: pageInfoFor(nodes.length, start, end), totalCount: nodes.length });
}

function resolveField(parent: Wrapped, field: FieldNode, ctx: ExecCtx): unknown {
  const args = evalArgs(field.args, ctx.variables);
  const typeName = parent.__typename;
  const name = field.name;

  if (typeName === 'Query') {
    if (name === '__type') {
      const typeNameArg = args.name;
      if (typeof typeNameArg !== 'string') return null;
      const desc = typeDescriptor(typeNameArg);
      return desc === null ? null : wrap('__Type', desc);
    }
    if (name === '__schema') {
      return wrap('__Schema', {
        queryType: { name: 'Query' },
        types: Object.keys(SCHEMA).map((n) => ({ name: n })),
      });
    }
    if (name === 'viewer') return wrap('User', VIEWER);
    if (name === 'repository') {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? getRepo(args.owner, args.name) : null;
      return repo === null ? null : repoWrap(repo);
    }
    if (name === 'node') {
      if (typeof args.id !== 'string') return null;
      const decoded = decodeGid(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromGid(args.id);
        return repo === null ? null : repoWrap(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGid(args.id);
        return found === null ? null : issueWrap(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGid(args.id);
        return found === null ? null : pullWrap(found.repo, found.pull);
      }
      return null;
    }
    throw new GqlError(`Cannot query field "${name}" on type "Query".`);
  }

  if (typeName === '__Type') {
    const desc = parent.value as Record<string, unknown>;
    if (name === 'name' || name === 'kind' || name === 'description') return desc[name] ?? null;
    if (name === 'fields') return (desc.fields as unknown[]) ?? null;
    if (name === 'enumValues') return (desc.enumValues as unknown[]) ?? null;
    if (name === 'inputFields') return (desc.inputFields as unknown[]) ?? null;
    throw new GqlError(`Cannot query field "${name}" on type "__Type".`);
  }

  if (typeName === '__Schema') {
    const schema = parent.value as Record<string, unknown>;
    if (name === 'queryType') return schema.queryType ?? null;
    if (name === 'types') return schema.types ?? null;
    throw new GqlError(`Cannot query field "${name}" on type "__Schema".`);
  }

  if (typeName === 'User') {
    const user = parent.value as typeof VIEWER;
    if (name === 'login') return user.login;
    if (name === 'id') return String(user.id);
    if (name === 'name') return user.name;
    if (name === 'email') return user.email;
    throw new GqlError(`Cannot query field "${name}" on type "User".`);
  }

  if (typeName === 'Repository') {
    const repo = parent.value as Repo;
    switch (name) {
      case 'id':
        return repoGid(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return wrap('User', VIEWER);
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip === null ? null : wrap('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((i) => i.number === number);
        return issue === undefined ? null : issueWrap(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        const nodes = issues.map((i) => ({ repo, issue: i }));
        return connectionOf(nodes, args, 'Issue', 'IssueConnection');
      }
      case 'pullRequests': {
        const nodes = [...repo.pulls]
          .sort((a, b) => a.number - b.number)
          .map((p) => ({ repo, pull: p }));
        return connectionOf(nodes, args, 'PullRequest', 'PullRequestConnection');
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull === undefined ? null : pullWrap(repo, pull);
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Repository".`);
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = parent.value as { repo: Repo; issue: Issue };
    switch (name) {
      case 'id':
        return issueGid(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state.toUpperCase();
      case 'body':
        return issue.body;
      default:
        throw new GqlError(`Cannot query field "${name}" on type "Issue".`);
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const conn = parent.value as { nodes: Wrapped[]; pageInfo: Wrapped; totalCount: number };
    if (name === 'nodes') return conn.nodes;
    if (name === 'pageInfo') return conn.pageInfo;
    if (name === 'totalCount') return conn.totalCount;
    throw new GqlError(`Cannot query field "${name}" on type "${typeName}".`);
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = parent.value as { repo: Repo; pull: Pull };
    switch (name) {
      case 'id':
        return pullGid(repo, pull);
      case 'number':
        return pull.number;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable':
        return pull.merged ? 'UNKNOWN' : pullMergeable(repo, pull);
      case 'files': {
        const files = pullFiles(repo, pull).map((f) => ({ path: String(f.filename) }));
        return connectionOf(files, args, 'PullRequestChangedFile', 'PullRequestChangedFileConnection');
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "PullRequest".`);
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = parent.value as { path: string };
    if (name === 'path') return file.path;
    throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
  }

  if (typeName === 'IssueComment') {
    const comment = parent.value as { id: number; body: string };
    if (name === 'id') return String(comment.id);
    if (name === 'body') return comment.body;
    throw new GqlError(`Cannot query field "${name}" on type "IssueComment".`);
  }

  if (typeName === 'CommentEdge') {
    const edge = parent.value as { node: Wrapped };
    if (name === 'node') return edge.node;
    throw new GqlError(`Cannot query field "${name}" on type "CommentEdge".`);
  }

  if (typeName === 'PageInfo') {
    const info = parent.value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    if (name === 'hasNextPage') return info.hasNextPage;
    if (name === 'hasPreviousPage') return info.hasPreviousPage;
    if (name === 'startCursor') return info.startCursor;
    if (name === 'endCursor') return info.endCursor;
    throw new GqlError(`Cannot query field "${name}" on type "PageInfo".`);
  }

  if (typeName === 'Ref') {
    const ref = parent.value as { name: string };
    if (name === 'name') return ref.name;
    throw new GqlError(`Cannot query field "${name}" on type "Ref".`);
  }

  if (typeName === 'Mutation') {
    const input = (args.input !== undefined && typeof args.input === 'object' && args.input !== null ? args.input : args) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = repoFromGid(input.repositoryId);
      if (repo === null) throw new GqlError('repository not found');
      const result = createIssueInRepo(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in result) throw new GqlError(result.error.message);
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, result.issue) });
    }
    if (name === 'closeIssue') {
      const found = issueFromGid(input.issueId);
      if (found === null) throw new GqlError('issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = tsIso(nextTs());
      return wrap('CloseIssuePayload', { issue: issueWrap(found.repo, found.issue) });
    }
    if (name === 'createPullRequest') {
      const repo = repoFromGid(input.repositoryId);
      if (repo === null) throw new GqlError('repository not found');
      const result = createPullInRepo(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) throw new GqlError(result.error.message);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, result.pull) });
    }
    if (name === 'mergePullRequest') {
      const found = pullFromGid(input.pullRequestId);
      if (found === null) throw new GqlError('pull request not found');
      const result = mergePullInRepo(found.repo, found.pull);
      if ('error' in result) throw new GqlError(result.error.message);
      return wrap('MergePullRequestPayload', { pullRequest: pullWrap(found.repo, found.pull) });
    }
    if (name === 'addComment') {
      const found = issueFromGid(input.subjectId);
      if (found === null) throw new GqlError('subject not found');
      const comment = {
        id: nextGlobalId(),
        body: String(input.body ?? ''),
        user: VIEWER.login,
        createdAt: tsIso(nextTs()),
      };
      found.issue.comments.push(comment);
      return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node: wrap('IssueComment', comment) }) });
    }
    throw new GqlError(`Cannot query field "${name}" on type "Mutation".`);
  }

  // Payload objects: issue / pullRequest / commentEdge.
  if (typeName.endsWith('Payload')) {
    const payload = parent.value as Record<string, unknown>;
    if (name in payload) return payload[name];
    throw new GqlError(`Cannot query field "${name}" on type "${typeName}".`);
  }

  throw new GqlError(`Cannot query field "${name}" on type "${typeName}".`);
}

function completeValue(field: FieldNode, raw: unknown, ctx: ExecCtx): unknown {
  if (raw === null || raw === undefined) return null;
  if (field.selectionSet === undefined) return raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in item) {
        return executeSelection(field.selectionSet!, item as Wrapped, ctx);
      }
      return item;
    });
  }
  if (typeof raw === 'object' && '__typename' in (raw as Record<string, unknown>)) {
    return executeSelection(field.selectionSet, raw as Wrapped, ctx);
  }
  return raw;
}

function executeSelection(selections: SelectionNode[], parent: Wrapped, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = parent.__typename;
        continue;
      }
      try {
        const raw = resolveField(parent, sel, ctx);
        out[key] = completeValue(sel, raw, ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
      }
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === undefined || sel.typeCondition === parent.__typename) {
        Object.assign(out, executeSelection(sel.selectionSet, parent, ctx));
      }
      continue;
    }
    const frag = ctx.fragments.get(sel.name);
    if (frag !== undefined && (frag.typeCondition === parent.__typename || frag.typeCondition === 'Node')) {
      Object.assign(out, executeSelection(frag.selectionSet, parent, ctx));
    }
  }
  return out;
}

function executeOne(
  definitions: Definition[],
  operationName: string | undefined,
  variables: Record<string, unknown>,
): { data: unknown; errors?: Array<{ message: string }> } {
  const operations = definitions.filter((d): d is OperationDef => d.kind === 'operation');
  const fragments = new Map<string, FragmentDef>();
  for (const d of definitions) if (d.kind === 'fragment') fragments.set(d.name, d);
  let op: OperationDef | undefined;
  if (operationName !== undefined) op = operations.find((o) => o.name === operationName);
  else if (operations.length === 1) op = operations[0];
  if (op === undefined) return { data: null, errors: [{ message: 'no operation found in GraphQL document' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (!(def.name in vars) && def.defaultValue !== undefined) vars[def.name] = evalValue(def.defaultValue, vars);
  }
  const ctx: ExecCtx = { variables: vars, fragments, errors: [] };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(op.selectionSet, wrap(rootType, null), ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- HTTP

export function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return;
  }
  const run = (doc: unknown): unknown => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { errors: [{ message: 'expected a GraphQL request object' }] };
    const query = (doc as Record<string, unknown>).query;
    const variables = (doc as Record<string, unknown>).variables;
    const operationName = (doc as Record<string, unknown>).operationName;
    if (typeof query !== 'string') return { errors: [{ message: 'query is required' }] };
    let definitions: Definition[];
    try {
      definitions = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    return executeOne(
      definitions,
      typeof operationName === 'string' ? operationName : undefined,
      variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
    );
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(run));
    return;
  }
  const result = run(parsed) as { errors?: Array<{ message: string }> };
  // A document that parsed but failed a field is HTTP 200 with errors; a
  // document that did not parse at all is a 400.
  const message = result.errors?.[0]?.message ?? '';
  if (result.errors !== undefined && (message.includes('unexpected') || message.includes('expected'))) {
    sendJson(res, 400, result);
    return;
  }
  sendJson(res, 200, result);
}
