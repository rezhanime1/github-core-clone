// The forge's in-memory store and its git object layer.
//
// One store per process: repositories hold refs, objects, issues, pull requests,
// labels and comments in Maps. Everything is deterministic: no wall clock is ever
// read — timestamps come from a counter seeded at a fixed epoch, ids are
// sequential, and tree entries are always written in git's canonical order.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The one authenticated user: the scenario's viewer (see the suite's wire.ts). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

/** Deterministic clock: every timestamp is BASE_TS + a counter, never Date.now(). */
export const BASE_TS = 1700000000;
let tsCounter = 0;
export function nextTs(): number {
  tsCounter += 1;
  return BASE_TS + tsCounter;
}
export function tsIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The SHA-1 of a git object: `<type> <size>\0` + bytes. */
export function oidOf(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
  headShaAtMerge: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  createdAt: string;
  updatedAt: string;
}

let repoIdCounter = 0;
let globalIdCounter = 0;
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export const repos = new Map<string, Repo>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

/** New repositories start with no labels: the suite creates the ones it uses
 * through POST /labels and expects a 201 for each. */
const DEFAULT_LABELS: ReadonlyArray<readonly [string, string]> = Object.freeze([]);

export function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  repoIdCounter += 1;
  globalIdCounter += 1;
  const ts = tsIso(nextTs());
  const repo: Repo = {
    id: repoIdCounter,
    name,
    owner: VIEWER.login,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssueNumber: 1,
    nextPullNumber: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  for (const [labelName, color] of DEFAULT_LABELS) {
    repo.labels.set(labelName, { name: labelName, color, description: '' });
  }
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function nextGlobalId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

// ---------------------------------------------------------------- git objects

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  // The stored message ends with one newline; the API reports it without.
  let message = split >= 0 ? text.slice(split + 2) : '';
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort: entries ordered by name, directories compared as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * Flatten a tree object into path -> {oid, mode}, walking nested trees.
 * Missing trees are treated as empty (a corrupt tip never crashes a read).
 */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested tree objects from a flat path map; returns the root tree oid. */
export function buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (!sub) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(path, file);
      }
    }
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    }
    return storeObject(repo, 'tree', encodeTree(sortTreeEntries(entries)));
  };
  return build('');
}

export function createCommit(repo: Repo, treeOid: string, parents: string[], message: string): { oid: string; ts: number } {
  const ts = nextTs();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  lines.push('');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  const oid = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  return { oid, ts };
}

/** The tip commit of a branch, or null when the ref does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** First-parent walk from a tip, newest first. */
export function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = tip;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    cur = parsed.parents.length > 0 ? parsed.parents[0]! : null;
  }
  return out;
}

/** All ancestors of an oid (commits, following every parent; tags peel to their target). */
export function ancestors(repo: Repo, oid: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) stack.push(m[1]!);
    }
  }
  return out;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return ancestors(repo, desc).has(anc);
}

/** The merge base of two tips: the first common ancestor walking the second's history. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAnc = ancestors(repo, a);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (aAnc.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** Peel a tag (recursively) to the commit it points at; commits pass through. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (!m) return null;
      cur = m[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** A tiny line diff (LCS) for the small files the suite uses. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: m - lcs, deletions: n - lcs };
}

/**
 * Every object oid reachable from a tree (the tree itself, nested trees, blobs).
 */
export function treeObjects(repo: Repo, treeOid: string, out: Set<string> = new Set()): Set<string> {
  const walk = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree' || out.has(oid)) return;
    out.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else out.add(entry.oid);
    }
  };
  walk(treeOid);
  return out;
}

/**
 * Everything the client already holds, from its haves: the have commits
 * themselves, their ancestors, and every tree and blob those commits reach.
 * The walk stops at a shallow boundary — the boundary commit is held, but
 * the history below it is not.
 */
export function heldObjects(repo: Repo, haves: string[], shallowBoundaries: string[]): Set<string> {
  const held = new Set<string>();
  const boundarySet = new Set(shallowBoundaries);
  const stack = [...haves];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (held.has(cur)) continue;
    held.add(cur);
    if (boundarySet.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      // treeObjects adds the tree itself; pre-adding it would trip its
      // already-visited guard and skip the entries.
      treeObjects(repo, parsed.tree, held);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) stack.push(m[1]!);
    }
  }
  return held;
}

/**
 * The set of objects a fetch must deliver for `wants`, minus what `haves`
 * already cover. With `depth`, generations are counted from the wants
 * (want = generation 0) and only generations below `depth` are in scope;
 * the walk passes through held commits so a deepen can extend a shallow
 * boundary, and the boundary commits are reported as shallow. Without a
 * depth the walk stops at held commits, as a normal incremental fetch does.
 * The pack never contains an object the client already holds.
 */
export function collectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | null,
  existingShallow: string[] = [],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const held = heldObjects(repo, [...haves], existingShallow);

  // In-scope commits with their generation from the wants.
  const inScope = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null) queue.push({ oid: commit, g: 0 });
  }
  while (queue.length > 0) {
    const { oid, g } = queue.shift()!;
    if (inScope.has(oid)) continue;
    if (depth !== null && g >= depth) continue;
    inScope.set(oid, g);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    // Without a depth limit, a held commit's history is already held.
    if (depth === null && held.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, g: g + 1 });
  }

  const objects = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj) objects.set(oid, obj);
  };
  // Wanted tag objects themselves ride along.
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj?.type === 'tag') addObject(want);
  }
  for (const commitOid of inScope.keys()) {
    if (held.has(commitOid)) continue;
    addObject(commitOid);
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    const treeOid = parseCommit(obj.data).tree;
    addObject(treeOid);
    const walkTree = (oid: string): void => {
      const tree = repo.objects.get(oid);
      if (!tree || tree.type !== 'tree') return;
      addObject(oid);
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') walkTree(entry.oid);
        else addObject(entry.oid);
      }
    };
    walkTree(treeOid);
  }

  // Shallow boundaries: the deepest in-scope generation, when a depth applies.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, g] of inScope) if (g === depth - 1) shallow.push(oid);
  }
  // Unshallow: an existing boundary this fetch now covers in full.
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const boundary of existingShallow) {
      if (!inScope.has(boundary)) continue;
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => inScope.has(p) || held.has(p))) unshallow.push(boundary);
    }
  }
  return { objects, shallow, unshallow };
}
