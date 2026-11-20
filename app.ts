// The HTTP server: routing only. /healthz, /api/v3/* (REST), /api/graphql,
// /mcp, and /{owner}/{repo}.git/* (smart HTTP). Auth (MAKEFUN_SHOP_TOKEN)
// guards the API surfaces; the git endpoints speak plain git, as a local
// git server does. Every reply is JSON unless it is a git advertisement,
// a pack result, or the push report.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { checkAuth, handleApi, sendJson } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, lookupGitRepo } from './git.ts';

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
}

function route(req: IncomingMessage, res: ServerResponse, pathname: string, method: string, body: Buffer): void {
  // Git smart HTTP: /{owner}/{repo}.git/info/refs, .../git-upload-pack, .../git-receive-pack.
  const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (gitMatch !== null) {
    let owner = gitMatch[1]!;
    let repoName = gitMatch[2]!;
    try {
      owner = decodeURIComponent(owner);
      repoName = decodeURIComponent(repoName);
    } catch {
      // Keep the raw segments on a decoding failure.
    }
    const tail = gitMatch[3]!;
    const repo = lookupGitRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && tail === 'info/refs') {
      let service = '';
      try {
        service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
      } catch {
        service = '';
      }
      handleInfoRefs(req, res, repo, service);
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      handleUploadPack(req, res, repo, body);
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      handleReceivePack(req, res, repo, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (pathname === '/api/graphql') {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    handleGraphql(req, res, body);
    return;
  }

  if (pathname === '/mcp') {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }
    handleMcp(req, res, body);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }
    handleApi(req, res, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      pathname = '/';
    }

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 128 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        route(req, res, pathname, method, Buffer.concat(chunks));
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    });
    req.on('error', () => {
      try {
        sendJson(res, 400, { message: 'bad request' });
      } catch {
        // Ignore.
      }
    });
  });
}
