// pkt-line framing and packfile read/write, from scratch (node:zlib, node:crypto).
//
// pkt-line: 4 hex digits (the length including the 4 digits) + payload;
// "0000" is flush, "0001" is delim. Packfiles are version 2, plain objects
// (no deltas written); reading resolves OFS_DELTA and REF_DELTA too, since a
// client may send either.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { oidOf, type GitObject, type ObjType } from './store.ts';

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse pkt-lines from the start of `buf`. Stops at the first flush/delim and
 * reports how many bytes were consumed, so a caller can read the raw pack
 * that follows a flush (receive-pack) or keep parsing section by section.
 */
export function parsePktLines(buf: Buffer): { packets: Pkt[]; consumed: number; complete: boolean } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, consumed: off + 4, complete: true };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      return { packets, consumed: off, complete: false };
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off, complete: false };
}

/** Parse every pkt-line in a buffer that holds only pkt-lines (advertisements). */
export function parseAllPktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    const { packets, consumed, complete } = parsePktLines(buf.subarray(off));
    out.push(...packets);
    off += consumed;
    if (!complete || consumed === 0) break;
    if (packets.length > 0 && packets[packets.length - 1]!.kind === 'flush') break;
  }
  return out;
}

/** One sideband frame: pkt-line( band byte + chunk ). A pkt-line is at most
 * 65520 bytes including its 4 length bytes, so a band-1 chunk is at most
 * 65515 data bytes. */
export function sidebandPackets(data: Buffer, band: 1 | 2 | 3 = 1): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65520 - 4 - 1;
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_NUM: Record<ObjType, number> = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });
const NUM_TYPE: Record<number, ObjType> = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

/** Write a version-2 pack of plain (undeltified) objects. */
export function writePack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects.values()];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.data.length;
    // Varint header: 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** A 0-object pack (32 bytes): what an empty fetch still has to send. */
export function emptyPack(): Buffer {
  return writePack([]);
}

/** Read a version-2/3 pack; resolves OFS_DELTA and REF_DELTA chains. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // Pack offset (header start) -> oid, for OFS_DELTA base lookup.
  const offsetToOid = new Map<number, string>();
  interface PendingDelta {
    kind: 'ofs' | 'ref';
    base: number | string;
    data: Buffer;
    offset: number;
  }
  const deltas: PendingDelta[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length) throw new Error('packfile truncated');
    const objStart = off;
    const typeNum = (buf[off]! >> 4) & 0x07;
    let size = buf[off]! & 0x0f;
    let shift = 4;
    let hasMore = (buf[off]! & 0x80) !== 0;
    off += 1;
    while (hasMore) {
      if (off >= buf.length) throw new Error('packfile truncated in object header');
      const byte = buf[off]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      hasMore = (byte & 0x80) !== 0;
      off += 1;
    }
    if (typeNum === 6) {
      // OFS_DELTA: the base offset is a negative varint from this object's start.
      let byte = buf[off]!;
      off += 1;
      let baseOff = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[off]!;
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      const start = off;
      const data = inflateSync(buf.subarray(off));
      off = start + inflatedLength(buf, start);
      deltas.push({ kind: 'ofs', base: objStart - baseOff, data, offset: objStart });
      continue;
    }
    if (typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const start = off;
      const data = inflateSync(buf.subarray(off));
      off = start + inflatedLength(buf, start);
      deltas.push({ kind: 'ref', base: baseOid, data, offset: objStart });
      continue;
    }
    const type = NUM_TYPE[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    const start = off;
    const data = inflateSync(buf.subarray(off));
    off = start + inflatedLength(buf, start);
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = oidOf(type, data);
    objects.set(oid, { type, data });
    offsetToOid.set(objStart, oid);
  }
  // Resolve deltas; a delta's base may itself be a delta, so loop until done.
  let pending = deltas;
  for (let round = 0; round < pending.length + 2 && pending.length > 0; round += 1) {
    const next: PendingDelta[] = [];
    for (const delta of pending) {
      let baseObj: GitObject | undefined;
      if (delta.kind === 'ref') baseObj = objects.get(delta.base as string);
      else {
        const baseOid = offsetToOid.get(delta.base as number);
        if (baseOid !== undefined) baseObj = objects.get(baseOid);
      }
      if (!baseObj) {
        next.push(delta);
        continue;
      }
      const data = applyDelta(baseObj.data, delta.data);
      const oid = oidOf(baseObj.type, data);
      objects.set(oid, { type: baseObj.type, data });
      offsetToOid.set(delta.offset, oid);
    }
    pending = next;
  }
  if (pending.length > 0) throw new Error('pack delta base not found');
  return objects;
}

/** How many bytes a zlib stream starting at `off` consumes.
 * inflateSync ignores trailing bytes and throws on a truncated stream, so
 * "inflates cleanly" is monotone in the end offset: binary-search the
 * smallest end that succeeds — that is the exact stream end. */
function inflatedLength(buf: Buffer, off: number): number {
  let lo = off + 1;
  let hi = buf.length;
  // A prefix shorter than the stream throws; a prefix at/after its end
  // succeeds. Find the smallest succeeding end.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  // Verify the candidate really inflates (a stream that never terminates).
  inflateSync(buf.subarray(off, lo));
  return lo - off;
}

/** Apply a git delta stream (source size, target size, copy/insert ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off]!;
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const targetSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          cpOff |= delta[off]! << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          cpSize |= delta[off]! << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}
