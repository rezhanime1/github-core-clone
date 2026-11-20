// REST v3: repositories, branches, commits, contents, labels, issues, pulls.
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// A repository under any owner but the token's login is 404, never 403.
// The domain operations (createIssue, createPull, mergePull) are shared with
// the GraphQL and MCP surfaces so all three read the same store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER,
  branchTip,
  buildTree,
  commitChain,
  createRepo as storeCreateRepo,
  flattenTree,
  getRepo,
  lineDiff,
  mergeBase,
  nextGlobalId,
  nextRequestId,
  nextTs,
  parseCommit,
  repos,
  storeObject,
  tsIso,
  createCommit,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token every API call presents (empty = accept all, local testing). */
export function tokenOf(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function checkAuth(req: IncomingMessage): boolean {
  const token = tokenOf();
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message, documentation_url: 'https://docs.github.com/rest' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, {
    message,
    errors: [{ resource: 'Issue', code: 'custom', field: 'title', message }],
    documentation_url: 'https://docs.github.com/rest',
  });
}

// ---------------------------------------------------------------- JSON shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`).toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 0,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description ?? '' };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: IssueComment, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: { login: comment.user, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function headShaOf(repo: Repo, pull: Pull): string | null {
  if (pull.merged && pull.headShaAtMerge !== null) return pull.headShaAtMerge;
  return branchTip(repo, pull.head);
}

function baseShaOf(repo: Repo, pull: Pull): string | null {
  return branchTip(repo, pull.base);
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = headShaOf(repo, pull);
  const baseSha = baseShaOf(repo, pull);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? false : pullMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: pull.merged ? 'unknown' : pullMergeable(repo, pull).toLowerCase(),
    user: { login: pull.user, id: VIEWER.id, type: 'User' },
    head: {
      ref: pull.head,
      sha: headSha,
      label: `${repo.owner}:${pull.head}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      label: `${repo.owner}:${pull.base}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(repo),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function branchJson(repo: Repo, branch: string, sha: string): Record<string, unknown> {
  const commit = commitJson(repo, sha);
  return {
    name: branch,
    commit: { sha, commit: commit?.commit ?? null, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const ts = parseInt((parsed.author.match(/ (\d+) \+0000$/) ?? [])[1] ?? '0', 10);
  const date = Number.isFinite(ts) && ts > 0 ? tsIso(ts) : repo.createdAt;
  const authorName = parsed.author.replace(/ <.*$/, '');
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: { name: authorName, email: VIEWER.email, date },
      committer: { name: authorName, email: VIEWER.email, date },
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

// ---------------------------------------------------------------- domain ops

export type DomainError = { status: number; message: string };

export function createIssueInRepo(
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): { issue: Issue } | { error: DomainError } {
  if (title.trim() === '') return { error: { status: 422, message: 'title is required' } };
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { error: { status: 422, message: `Validation Failed: label "${name}" does not exist` } };
    labels.push(label);
  }
  const ts = tsIso(nextTs());
  const issue: Issue = {
    id: nextGlobalId(),
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    user: VIEWER.login,
  };
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return { issue };
}

export function createPullInRepo(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull } | { error: DomainError } {
  if (title.trim() === '') return { error: { status: 422, message: 'title is required' } };
  if (branchTip(repo, head) === null) return { error: { status: 422, message: `Validation Failed: head branch "${head}" does not exist` } };
  if (branchTip(repo, base) === null) return { error: { status: 422, message: `Validation Failed: base branch "${base}" does not exist` } };
  const ts = tsIso(nextTs());
  const pull: Pull = {
    id: nextGlobalId(),
    number: repo.nextPullNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    user: VIEWER.login,
    headShaAtMerge: null,
  };
  repo.nextPullNumber += 1;
  repo.pulls.push(pull);
  return { pull };
}

/** MERGEABLE when the head's changes apply cleanly onto the base tip. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = branchTip(repo, pull.base);
  const headTip = headShaOf(repo, pull);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base !== null ? flattenTreeOfCommit(repo, base) : new Map();
  const headTree = flattenTreeOfCommit(repo, headTip);
  const baseTipTree = flattenTreeOfCommit(repo, baseTip);
  for (const [path, headFile] of headTree) {
    const baseFile = baseTree.get(path);
    const tipFile = baseTipTree.get(path);
    const headChanged = baseFile?.oid !== headFile.oid;
    const tipChanged = baseFile?.oid !== tipFile?.oid;
    if (headChanged && tipChanged && tipFile?.oid !== headFile.oid) return 'CONFLICTING';
  }
  for (const [path, baseFile] of baseTree) {
    if (headTree.has(path)) continue;
    const tipFile = baseTipTree.get(path);
    if (tipFile?.oid !== baseFile.oid && tipFile !== undefined) return 'CONFLICTING';
    if (tipFile === undefined && baseFile !== undefined) {
      // Head deleted the file while base modified it.
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

function flattenTreeOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

export function mergePullInRepo(
  repo: Repo,
  pull: Pull,
): { sha: string } | { error: DomainError } {
  if (pull.merged) return { error: { status: 405, message: 'Pull Request is already merged' } };
  if (pull.state !== 'open') return { error: { status: 405, message: 'Pull Request is closed' } };
  if (pullMergeable(repo, pull) !== 'MERGEABLE') {
    return { error: { status: 405, message: 'Merge conflict' } };
  }
  const baseTip = branchTip(repo, pull.base)!;
  const headTip = headShaOf(repo, pull)!;
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base !== null ? flattenTreeOfCommit(repo, base) : new Map<string, { oid: string; mode: string }>();
  const headTree = flattenTreeOfCommit(repo, headTip);
  const baseTipTree = flattenTreeOfCommit(repo, baseTip);
  const merged = new Map(baseTipTree);
  for (const [path, file] of headTree) {
    if (baseTree.get(path)?.oid !== file.oid) merged.set(path, file);
  }
  for (const path of baseTree.keys()) {
    if (!headTree.has(path)) merged.delete(path);
  }
  const treeOid = buildTree(repo, merged);
  const { oid } = createCommit(repo, treeOid, [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.base}`, oid);
  const ts = tsIso(nextTs());
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = ts;
  pull.mergeCommitSha = oid;
  pull.updatedAt = ts;
  pull.closedAt = ts;
  pull.headShaAtMerge = headTip;
  return { sha: oid };
}

/** The file diff of a pull request: merge-base tree vs head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const headTip = headShaOf(repo, pull);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base !== null ? flattenTreeOfCommit(repo, base) : new Map();
  const headTree = flattenTreeOfCommit(repo, headTip);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const from = baseTree.get(path);
    const to = headTree.get(path);
    if (from === undefined && to !== undefined) {
      const content = repo.objects.get(to.oid)?.data.toString('utf8') ?? '';
      const additions = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to === undefined) {
      const content = repo.objects.get(from.oid)?.data.toString('utf8') ?? '';
      const deletions = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const oldText = repo.objects.get(from.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(to.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- routing

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawUrl: string;
}

function dec(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The repository for a route, or null (404 — including a foreign owner). */
function repoOf(ctx: Ctx, ownerSeg: number, nameSeg: number): Repo | null {
  const owner = dec(ctx.segments[ownerSeg]!);
  const name = dec(ctx.segments[nameSeg]!);
  if (owner !== VIEWER.login) return null;
  return getRepo(owner, name);
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function linkHeader(ctx: Ctx, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const path = ctx.rawUrl.split('?')[0];
  // Link URLs must be absolute: the client follows them off-origin otherwise.
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const build = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(`${build(1)}; rel="first"`);
    links.push(`${build(page - 1)}; rel="prev"`);
  }
  if (page < totalPages) {
    links.push(`${build(page + 1)}; rel="next"`);
    links.push(`${build(totalPages)}; rel="last"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

function paged<T>(ctx: Ctx, items: T[]): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), link: linkHeader(ctx, page, perPage, items.length) };
}

function listResponse<T>(ctx: Ctx, items: T[]): void {
  const { items: page, link } = paged(ctx, items);
  sendJson(ctx.res, 200, page, link !== null ? { link } : {});
}

function bodyRecord(ctx: Ctx): Record<string, unknown> {
  return (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
}

function strField(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------- contents

function contentsFileJson(repo: Repo, path: string, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const data = obj?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    download_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

function handleGetContents(ctx: Ctx, repo: Repo, path: string): void {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, ref);
  if (tip === null) {
    notFound(ctx.res);
    return;
  }
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  const flat = flattenTree(repo, treeOid);
  const file = flat.get(path);
  if (file !== undefined) {
    sendJson(ctx.res, 200, contentsFileJson(repo, path, file.oid));
    return;
  }
  // A directory: its immediate children.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const size = repo.objects.get(entry.oid)?.data.length ?? 0;
      children.set(rest, { type: 'file', oid: entry.oid, size });
    } else {
      children.set(rest.slice(0, slash), { type: 'dir', oid: '', size: 0 });
    }
  }
  if (children.size === 0) {
    notFound(ctx.res);
    return;
  }
  const out = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: `${prefix}${name}`,
      sha: entry.oid,
      size: entry.size,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${prefix}${name}`,
    }));
  sendJson(ctx.res, 200, out);
}

function handlePutContents(ctx: Ctx, repo: Repo, path: string): void {
  const body = bodyRecord(ctx);
  const message = strField(body, 'message') || `Update ${path}`;
  const contentB64 = strField(body, 'content');
  const sha = strField(body, 'sha');
  const branch = strField(body, 'branch') || repo.defaultBranch;
  if (contentB64 === '') {
    unprocessable(ctx.res, 'content is required');
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
    if (content.length === 0 && contentB64.replace(/=+$/, '') !== '') throw new Error('bad base64');
  } catch {
    sendJson(ctx.res, 400, { message: 'content is not valid base64' });
    return;
  }
  let tip = branchTip(repo, branch);
  if (tip === null) {
    // Create the branch from the default tip (or unborn when the repo is empty).
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (branch !== repo.defaultBranch && defaultTip !== null) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const flat = tip !== null ? flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  if (existing !== undefined && sha !== '' && sha !== existing.oid) {
    sendJson(ctx.res, 409, { message: 'the sha does not match the current file' });
    return;
  }
  const created = existing === undefined;
  const blobOid = storeObject(repo, 'blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTree(repo, flat);
  const parents = tip !== null ? [tip] : [];
  const { oid: commitOid } = createCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = tsIso(nextTs());
  sendJson(ctx.res, created ? 201 : 200, {
    content: contentsFileJson(repo, path, blobOid),
    commit: { sha: commitOid, message },
  });
}

function handleDeleteContents(ctx: Ctx, repo: Repo, path: string): void {
  const body = bodyRecord(ctx);
  const message = strField(body, 'message') || `Delete ${path}`;
  const sha = strField(body, 'sha');
  const branch = strField(body, 'branch') || repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) {
    notFound(ctx.res);
    return;
  }
  const flat = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const existing = flat.get(path);
  if (existing === undefined) {
    notFound(ctx.res);
    return;
  }
  if (sha !== '' && sha !== existing.oid) {
    sendJson(ctx.res, 409, { message: 'the sha does not match the current file' });
    return;
  }
  flat.delete(path);
  const treeOid = buildTree(repo, flat);
  const { oid: commitOid } = createCommit(repo, treeOid, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(ctx.res, 200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- the router

export function handleApi(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    sendJson(res, 400, { message: 'bad request' });
    return;
  }
  const method = req.method ?? 'GET';
  const segments = pathname.split('/').filter((s) => s !== '');

  // JSON bodies: malformed JSON is a 400 on any route that takes a body.
  let body: unknown = null;
  if (rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      body = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }
  const ctx: Ctx = { req, res, segments, query, body, rawUrl: req.url ?? pathname };

  // The API root.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3' && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
      installed_version: '1.0.0',
      domains: {},
    });
    return;
  }
  // GET /user and /user/repos.
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const all = [...getViewerRepos()].map(repoJson);
      listResponse(ctx, all);
      return;
    }
    if (method === 'POST') {
      const b = bodyRecord(ctx);
      const name = strField(b, 'name');
      if (name === '' || /[\s/]/.test(name)) {
        unprocessable(res, 'name is required');
        return;
      }
      if (getRepo(VIEWER.login, name) !== null) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return;
      }
      const repo = storeCreateRepo(name, strField(b, 'description'), b.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /repos/{owner}/{repo}[/...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const repo = repoOf(ctx, 3, 4);
    if (repo === null) {
      notFound(res);
      return;
    }
    const rest = segments.slice(5);
    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const b = bodyRecord(ctx);
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        repo.updatedAt = tsIso(nextTs());
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(`${repo.owner}/${repo.name}`);
        sendNoContent(res);
        return;
      }
      notFound(res);
      return;
    }
    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => branchJson(repo, name, repo.refs.get(`refs/heads/${name}`)!));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const name = dec(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${name}`);
        if (sha === undefined) {
          notFound(res, 'Branch not found');
          return;
        }
        sendJson(res, 200, branchJson(repo, name, sha));
        return;
      }
      notFound(res);
      return;
    }
    // Commits.
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 1) {
        const ref = query.get('sha') ?? repo.defaultBranch;
        let tip: string | null = repo.refs.get(`refs/heads/${ref}`) ?? null;
        if (tip === null && /^[0-9a-f]{40}$/.test(ref)) tip = repo.objects.has(ref) ? ref : null;
        if (tip === null) {
          notFound(res, 'No commit found for SHA');
          return;
        }
        const commits = commitChain(repo, tip)
          .map((oid) => commitJson(repo, oid))
          .filter((c): c is Record<string, unknown> => c !== null);
        listResponse(ctx, commits);
        return;
      }
      if (rest.length === 2) {
        const oid = dec(rest[1]!);
        const commit = commitJson(repo, oid);
        if (commit === null) {
          notFound(res);
          return;
        }
        sendJson(res, 200, commit);
        return;
      }
      notFound(res);
      return;
    }
    // Git Data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const all = sortedRefsOf(repo).map((r) => ({
          ref: r.name,
          object: { sha: r.oid, type: repo.objects.get(r.oid)?.type ?? 'commit' },
        }));
        sendJson(res, 200, all);
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const b = bodyRecord(ctx);
        const ref = strField(b, 'ref');
        const sha = strField(b, 'sha');
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          unprocessable(res, 'ref and sha are required and the sha must exist');
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map(dec).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
        return;
      }
      notFound(res);
      return;
    }
    // Contents.
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(dec).join('/');
      if (method === 'GET') {
        handleGetContents(ctx, repo, path);
        return;
      }
      if (method === 'PUT') {
        handlePutContents(ctx, repo, path);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteContents(ctx, repo, path);
        return;
      }
      notFound(res);
      return;
    }
    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const b = bodyRecord(ctx);
        const name = strField(b, 'name');
        if (name === '') {
          unprocessable(res, 'name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Label already exists' });
          return;
        }
        const label: Label = { name, color: strField(b, 'color') || 'ededed', description: strField(b, 'description') };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      notFound(res);
      return;
    }
    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          listResponse(ctx, issues.map((i) => issueJson(i, repo)));
          return;
        }
        if (method === 'POST') {
          const b = bodyRecord(ctx);
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          const result = createIssueInRepo(repo, strField(b, 'title'), strField(b, 'body'), labels);
          if ('error' in result) {
            sendJson(res, result.error.status, { message: result.error.message });
            return;
          }
          sendJson(res, 201, issueJson(result.issue, repo));
          return;
        }
      }
      const number = parseInt(dec(rest[1] ?? ''), 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        notFound(res);
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue, repo));
          return;
        }
        if (method === 'PATCH') {
          const b = bodyRecord(ctx);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'closed' || b.state === 'open') {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? tsIso(nextTs()) : null;
          }
          issue.updatedAt = tsIso(nextTs());
          sendJson(res, 200, issueJson(issue, repo));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => commentJson(c, repo, issue)));
          return;
        }
        if (method === 'POST') {
          const b = bodyRecord(ctx);
          const commentBody = strField(b, 'body');
          if (commentBody === '') {
            unprocessable(res, 'body is required');
            return;
          }
          const comment: IssueComment = {
            id: nextGlobalId(),
            body: commentBody,
            user: VIEWER.login,
            createdAt: tsIso(nextTs()),
          };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(comment, repo, issue));
          return;
        }
      }
      notFound(res);
      return;
    }
    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
          pulls.sort((a, b) => b.number - a.number);
          listResponse(ctx, pulls.map((p) => pullJson(p, repo)));
          return;
        }
        if (method === 'POST') {
          const b = bodyRecord(ctx);
          const result = createPullInRepo(repo, strField(b, 'title'), strField(b, 'body'), strField(b, 'head'), strField(b, 'base'));
          if ('error' in result) {
            sendJson(res, result.error.status, { message: result.error.message });
            return;
          }
          sendJson(res, 201, pullJson(result.pull, repo));
          return;
        }
      }
      const number = parseInt(dec(rest[1] ?? ''), 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) {
        notFound(res);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(pull, repo));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
        const headTip = headShaOf(repo, pull);
        const baseTip = branchTip(repo, pull.base);
        let commits: Array<Record<string, unknown>> = [];
        if (headTip !== null && baseTip !== null) {
          const base = mergeBase(repo, baseTip, headTip);
          const baseAnc = base !== null ? new Set(commitChain(repo, base)) : new Set<string>();
          commits = commitChain(repo, headTip)
            .filter((oid) => !baseAnc.has(oid))
            .map((oid) => commitJson(repo, oid))
            .filter((c): c is Record<string, unknown> => c !== null);
        }
        sendJson(res, 200, commits);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const result = mergePullInRepo(repo, pull);
        if ('error' in result) {
          sendJson(res, result.error.status, { message: result.error.message });
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

function getViewerRepos(): Repo[] {
  return [...repos.values()].filter((r) => r.owner === VIEWER.login);
}

function sortedRefsOf(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
