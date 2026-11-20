// MCP at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28
// (server/discover, no handshake, no session) with the legacy initialize
// handshake kept as a fallback. Plain JSON answers, never SSE. The six tools
// act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, createRepo as storeCreateRepo, getRepo, type Repo } from './store.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  issueJson,
  mergePullInRepo,
  pullJson,
  repoJson,
  sendJson,
} from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in a fixed order: two tools/list calls are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return null;
  if (owner !== VIEWER.login) return null;
  return getRepo(owner, repo);
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (getRepo(VIEWER.login, repoName) !== null) return toolError(`repository ${VIEWER.login}/${repoName} already exists`);
    const repo = storeCreateRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return toolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const repo = repoFor(args);
    if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = repoFor(args);
    if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
    const result = createIssueInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in result) return toolError(result.error.message);
    return toolResult(issueJson(result.issue, repo));
  }
  if (name === 'list_issues') {
    const repo = repoFor(args);
    if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    return toolResult(issues.map((i) => issueJson(i, repo)));
  }
  if (name === 'create_pull_request') {
    const repo = repoFor(args);
    if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
    const result = createPullInRepo(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      String(args.head),
      String(args.base),
    );
    if ('error' in result) return toolError(result.error.message);
    const json = pullJson(result.pull, repo) as Record<string, unknown>;
    json.pull_number = result.pull.number;
    return toolResult(json);
  }
  if (name === 'merge_pull_request') {
    const repo = repoFor(args);
    if (repo === null) return toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return toolError(`pull request #${String(args.pull_number)} not found`);
    const result = mergePullInRepo(repo, pull);
    if ('error' in result) return toolError(result.error.message);
    const json = pullJson(pull, repo) as Record<string, unknown>;
    json.pull_number = pull.number;
    return toolResult(json);
  }
  return toolError(`unknown tool ${name}`);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': 'req-mcp' });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const msg = body as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;

  // A notification (no id) is answered with an empty 202.
  if (id === null && (method.startsWith('notifications/') || method === '')) {
    res.writeHead(202);
    res.end();
    return;
  }

  // The modern era declares its revision in _meta; refuse one we never listed.
  const meta = params._meta;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const declared = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];
    if (typeof declared === 'string' && !SUPPORTED_VERSIONS.includes(declared)) {
      sendJson(res, 200, rpcError(id, -32022, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS] }));
      return;
    }
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, discoverResult()));
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    if (TOOLS.find((t) => t.name === toolName) === undefined) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    try {
      sendJson(res, 200, rpcResult(id, callTool(toolName, args)));
    } catch (err) {
      sendJson(res, 200, rpcError(id, -32602, err instanceof Error ? err.message : String(err)));
    }
    return;
  }
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
