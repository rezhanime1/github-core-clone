// Git smart HTTP: info/refs, upload-pack (v0 and v2) and receive-pack (v0).
//
// The wire shapes come from the suite's own git client: v0 advertisements
// carry `# service=...` + a flush + ref lines with capabilities after NUL on
// the first line; v2 advertisements are `version 2` + capability lines;
// fetch answers come in sections (v2) or as NAK + shallow lines + sideband
// pack (v0); push answers are a pkt-framed report inside sideband band 1.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  ZERO_OID,
  branchTip,
  collectFetchObjects,
  getRepo,
  isAncestor,
  type Repo,
} from './store.ts';
import {
  emptyPack,
  parseAllPktLines,
  parsePktLines,
  pktFlush,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
} from './pkt.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_V0_CAPS = 'side-band-64k shallow thin-pack ofs-delta';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The annotated-tag target a ref peels to, when it is a tag object. */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
  return m ? m[1]! : null;
}

function headOid(repo: Repo): string | null {
  return branchTip(repo, repo.defaultBranch);
}

/** The v0 advertisement body for a service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const capsWithSymref = `${caps} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsWithSymref}\n`));
  } else {
    parts.push(pktLine(`${head ?? ZERO_OID} HEAD\0${capsWithSymref}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement body (upload-pack only; receive-pack has no v2). */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
): void {
  if (service === 'git-upload-pack') {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      send(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      send(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    send(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  send(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'unknown service' })));
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const packets = parseAllPktLines(body);
  if (packets.length === 0) return null;
  const first = packets[0];
  if (first!.kind !== 'data') return null;
  const commandLine = first!.payload.toString('utf8').replace(/\n$/, '');
  if (!commandLine.startsWith('command=')) return null;
  const command = commandLine.slice('command='.length);
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets.slice(1)) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    if (!pastDelim) continue; // command capabilities (agent=, object-format=): ignore
    args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

function fetchArgsFrom(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

/** The ls-refs answer: one line per ref, HEAD first when symrefs is on. */
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (symrefs && keep('HEAD')) {
    if (head !== null) parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 fetch answer: acknowledgments, shallow-info (when needed), packfile. */
function fetchV2Response(repo: Repo, fargs: FetchArgs): Buffer {
  const haves = new Set(fargs.haves);
  const { objects, shallow, unshallow } = collectFetchObjects(repo, fargs.wants, haves, fargs.depth, fargs.shallow);
  const pack = objects.size === 0 ? emptyPack() : writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktFlush());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK, shallow lines, then the sideband pack. */
function fetchV0Response(repo: Repo, fargs: FetchArgs): Buffer {
  const haves = new Set(fargs.haves);
  const { objects, shallow, unshallow } = collectFetchObjects(repo, fargs.wants, haves, fargs.depth, fargs.shallow);
  const pack = objects.size === 0 ? emptyPack() : writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  try {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      const parsed = parseV2Command(body);
      if (parsed === null) throw new Error('bad v2 command');
      if (parsed.command === 'ls-refs') {
        send(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parsed.args));
        return;
      }
      if (parsed.command === 'fetch') {
        send(res, 200, 'application/x-git-upload-pack-result', fetchV2Response(repo, fetchArgsFrom(parsed.args)));
        return;
      }
      throw new Error(`unknown v2 command ${parsed.command}`);
    }
    // v0: two sections — wants (+shallow/deepen), flush, haves + done, flush.
    const first = parsePktLines(body);
    if (!first.complete) throw new Error('bad v0 fetch request');
    const args1: string[] = [];
    for (const packet of first.packets) {
      if (packet.kind === 'data') {
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        // The first want line may carry capabilities after a space: keep the oid.
        args1.push(line.startsWith('want ') ? `want ${line.slice(5).split(' ')[0]}` : line);
      }
    }
    const rest = body.subarray(first.consumed);
    const second = parsePktLines(rest);
    const args2: string[] = [];
    for (const packet of second.packets) {
      if (packet.kind === 'data') args2.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const fargs = fetchArgsFrom([...args1, ...args2]);
    send(res, 200, 'application/x-git-upload-pack-result', fetchV0Response(repo, fargs));
  } catch (err) {
    // A malformed upload-pack must not take the server down.
    const message = err instanceof Error ? err.message : String(err);
    send(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message })));
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const report = (lines: string[]): void => {
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
    const outer = Buffer.concat([...sidebandPackets(inner, 1), pktFlush()]);
    send(res, 200, 'application/x-git-receive-pack-result', outer);
  };
  try {
    const first = parsePktLines(body);
    if (!first.complete) throw new Error('bad receive-pack request');
    const commands: PushCommand[] = [];
    for (const packet of first.packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
      if (!m) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
    const packBytes = body.subarray(first.consumed);
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (hasUpdates) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error: missing packfile';
      } else {
        try {
          const objects = readPack(packBytes);
          for (const [oid, obj] of objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const cmd of commands) {
      if (!unpackOk) {
        lines.push(`ng ${cmd.ref} unpack failed\n`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          lines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          lines.push(`ng ${cmd.ref} stale info\n`);
        } else {
          repo.refs.delete(cmd.ref);
          lines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        lines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          lines.push(`ng ${cmd.ref} stale info\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        lines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (cmd.oldOid !== current) {
        lines.push(`ng ${cmd.ref} stale info\n`);
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
    }
    report(lines);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message })));
  }
}

export function lookupGitRepo(owner: string, name: string): Repo | null {
  return getRepo(owner, name);
}
