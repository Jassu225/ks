// lib/outbox.ts — SERVER-only twin of src/lib/db/outbox.ts (web can't import
// src). Offline mode: a board write that can't reach Firestore is appended to
// <dataDir>/outbox/ and the daemon syncs it later. The FILE FORMAT and the
// queueing rules must stay identical to src/lib/db/outbox.ts:
//   - one JSON file per write, `<epoch-ms>-<pid>-<seq>.json` (name sort = FIFO);
//   - entry { op: 'set'|'delete'|'merge', path, data?, at, reason };
//   - WRITE_TIMEOUT_MS per write; a network failure or the timeout queues it;
//   - while the outbox holds anything, every new write is queued too.
// The board never flushes; it also reads the queue to overlay pending writes on
// what it shows (app/api/store/live, serverdb reads while offline).
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadOnlyError, readOnlyReason } from './readonly';

export type OutboxOp = 'set' | 'delete' | 'merge';

export interface OutboxEntry {
  op: OutboxOp;
  path: string;
  data?: Record<string, unknown>;
  at: string;
  reason: 'timeout' | 'network' | 'order';
}

export interface StoreOp {
  op: OutboxOp;
  path: string;
  data?: Record<string, unknown>;
}

export const WRITE_TIMEOUT_MS = 8_000;

class WriteTimeout extends Error {
  constructor(ms: number) {
    super(`write timed out after ${ms} ms`);
    this.name = 'WriteTimeout';
  }
}

const NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
]);
const NET_TEXT =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|socket hang up|UNAVAILABLE|DEADLINE_EXCEEDED|Could not refresh access token|network/i;

export function isNetworkError(e: unknown): boolean {
  if (e instanceof WriteTimeout) return true;
  const err = e as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!err) return false;
  if (err.code === 14 || err.code === 4) return true;
  if (typeof err.code === 'string' && NET_CODES.has(err.code)) return true;
  if (typeof err.message === 'string' && NET_TEXT.test(err.message)) return true;
  return err.cause ? isNetworkError(err.cause) : false;
}

export function withTimeout<T>(p: Promise<T>, ms = WRITE_TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new WriteTimeout(ms)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

export const outboxDir = (dataDir: string): string => join(dataDir, 'outbox');

export function outboxFiles(dataDir: string): string[] {
  try {
    return readdirSync(outboxDir(dataDir))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

export function outboxEntries(dataDir: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const f of outboxFiles(dataDir)) {
    try {
      out.push(JSON.parse(readFileSync(join(outboxDir(dataDir), f), 'utf8')) as OutboxEntry);
    } catch {
      /* half-written or corrupt: the daemon's flusher moves it aside */
    }
  }
  return out;
}

let seq = 0;

function enqueue(dataDir: string, ops: StoreOp[], reason: OutboxEntry['reason']): void {
  const dir = outboxDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  for (const o of ops) {
    const name = `${Date.now()}-${String(process.pid).padStart(7, '0')}-${String(seq++).padStart(6, '0')}.json`;
    const entry: OutboxEntry = { op: o.op, path: o.path, at, reason };
    if (o.data !== undefined) entry.data = o.data;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, join(dir, name));
  }
}

/** Write through `apply`, or queue (rules at the top). Bad-data errors still throw. */
export async function writeOrQueue(
  dataDir: string,
  ops: StoreOp[],
  apply: (ops: StoreOp[]) => Promise<void>,
): Promise<void> {
  if (ops.length === 0) return;
  // Behind on the store's data format (lib/readonly.ts): never written, never
  // queued. The routes answer 409 before getting here; this is the backstop.
  const readOnly = readOnlyReason(dataDir);
  if (readOnly) throw new ReadOnlyError(readOnly);
  if (outboxFiles(dataDir).length > 0) {
    enqueue(dataDir, ops, 'order');
    return;
  }
  try {
    await withTimeout(apply(ops));
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    enqueue(dataDir, ops, e instanceof WriteTimeout ? 'timeout' : 'network');
    console.error(`[ks-flow outbox] offline: queued ${ops.length} write(s) (${(e as Error).message})`);
  }
}

/**
 * Apply the queued writes for documents directly under `collectionPath` to a
 * list of docs (keyed by `idOf`), so what the board shows includes changes not
 * synced yet. `keep` re-checks a query's filter on a changed doc.
 */
export function overlay<T>(
  docs: T[],
  entries: OutboxEntry[],
  collectionPath: string,
  idOf: (d: T) => string,
  keep: (d: T) => boolean = () => true,
): T[] {
  const prefix = `${collectionPath}/`;
  const relevant = entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'));
  if (relevant.length === 0) return docs;
  const byId = new Map<string, T>();
  for (const d of docs) byId.set(idOf(d), d);
  for (const e of relevant) {
    const id = e.path.slice(prefix.length);
    if (e.op === 'delete') byId.delete(id);
    else if (e.op === 'set') byId.set(id, e.data as T);
    else {
      const prev = byId.get(id);
      if (prev) byId.set(id, { ...prev, ...(e.data ?? {}) } as T);
    }
  }
  return [...byId.values()].filter(keep);
}
