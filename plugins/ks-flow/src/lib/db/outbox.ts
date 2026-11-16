// lib/db/outbox.ts — offline mode for the Firestore store: writes that can't
// reach Firestore are kept on disk and applied once the Mac is back online.
//
// One JSON file per write in <dataDir>/outbox/, named
// `<epoch-ms>-<pid>-<seq>.json` so a plain name sort is FIFO and two processes
// never collide. Every process that writes (the daemon, the backup/briefing
// CLIs, the board's server via its twin web/lib/outbox.ts — SAME file format)
// appends here; only the daemon flushes (it is always on).
//
// Rules:
//   - A write gets WRITE_TIMEOUT_MS. A network/availability failure (or the
//     timeout: firebase-admin retries offline until its own deadline instead of
//     failing fast) queues it; the caller sees success.
//   - While the outbox holds anything, every new write is queued too, so a late
//     flush of an old entry can't overwrite a newer write.
//   - Any other error (bad data) is thrown to the caller as before.
//   - The flusher folds the queue per document (writes are whole-doc sets; a
//     merge is folded into the set before it), applies in batches, deletes each
//     file once applied, stops at the first network failure, and moves a file
//     whose write is refused for any other reason to outbox/failed/.
//   - A write that timed out may still land later (firebase-admin keeps
//     retrying it until its deadline), so nothing is flushed until the newest
//     timed-out entry is SETTLE_MS old: the late original can't then overwrite
//     the flushed, newer state.
//   - The write gate (`blocked`, lib/versioning.ts storeWriteBlock): while this
//     device is behind on the store's data format, a write is DROPPED, not
//     queued (replaying old-format writes after the update would undo the new
//     format), and the flusher holds what was queued before.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type OutboxOp = 'set' | 'delete' | 'merge';

/** One queued write. `path` is the full document path, e.g.
 * `reminders/<uid>` or `slack_names/<uid>`. */
export interface OutboxEntry {
  op: OutboxOp;
  path: string;
  data?: Record<string, unknown>;
  /** ISO time it was queued. */
  at: string;
  /** Why it was queued: the write timed out, failed on the network, or the
   * outbox was already non-empty. */
  reason: 'timeout' | 'network' | 'order';
}

export interface StoreOp {
  op: OutboxOp;
  path: string;
  data?: Record<string, unknown>;
}

/** What the outbox writes through: Firestore in production, a fake in tests. */
export interface DocStore {
  /** Apply the ops together (one batch when more than one). */
  apply(ops: StoreOp[]): Promise<void>;
}

export interface FlushResult {
  applied: number;
  failed: number;
  remaining: number;
  /** Stopped on a network failure (try again later, with backoff). */
  offline: boolean;
  /** Waiting for a timed-out write to settle (see SETTLE_MS). */
  settling: boolean;
}

export const WRITE_TIMEOUT_MS = 8_000;
/** firebase-admin's own commit deadline is 60 s; wait a little longer. */
export const SETTLE_MS = 70_000;
const MAX_BATCH = 500;

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

/** True when an error means "Firestore can't be reached", not "the write is bad".
 * gRPC: 14 UNAVAILABLE, 4 DEADLINE_EXCEEDED; Node: DNS / socket errors. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof WriteTimeout) return true;
  const err = e as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!err) return false;
  if (err.code === 14 || err.code === 4) return true;
  if (typeof err.code === 'string' && NET_CODES.has(err.code)) return true;
  if (typeof err.message === 'string' && NET_TEXT.test(err.message)) return true;
  return err.cause ? isNetworkError(err.cause) : false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new WriteTimeout(ms)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

export interface OutboxOptions {
  timeoutMs?: number;
  settleMs?: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  /** Why writes are off now (null: allowed). A blocked write is dropped; flushing waits. */
  blocked?: () => string | null;
}

let seq = 0;

/** Log a dropped write at most this often (per outbox). */
const DROP_LOG_MS = 5 * 60_000;

export class Outbox {
  readonly dir: string;
  readonly failedDir: string;
  private timeoutMs: number;
  private settleMs: number;
  private now: () => number;
  private log: (...a: unknown[]) => void;
  private flushing: Promise<FlushResult> | null = null;
  private blocked: () => string | null;
  /** Writes dropped by the gate (this process). */
  dropped = 0;
  private droppedUnlogged = 0;
  private droppedLoggedAt = 0;

  constructor(
    dir: string,
    private store: DocStore,
    opts: OutboxOptions = {},
  ) {
    this.dir = dir;
    this.failedDir = join(dir, 'failed');
    this.timeoutMs = opts.timeoutMs ?? WRITE_TIMEOUT_MS;
    this.settleMs = opts.settleMs ?? SETTLE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((...a) => console.error('[ks-flow outbox]', ...a));
    this.blocked = opts.blocked ?? (() => null);
  }

  /** Why store writes are off now, or null. */
  writeBlock(): string | null {
    try {
      return this.blocked();
    } catch {
      return null;
    }
  }

  private drop(n: number, why: string): void {
    this.dropped += n;
    this.droppedUnlogged += n;
    const now = this.now();
    if (this.droppedLoggedAt && now - this.droppedLoggedAt < DROP_LOG_MS) return;
    this.log(`dropped ${this.droppedUnlogged} write(s): ${why}`);
    this.droppedUnlogged = 0;
    this.droppedLoggedAt = now;
  }

  /** Queued file names, oldest first. */
  files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      return [];
    }
  }

  pending(): number {
    return this.files().length;
  }

  entries(): Array<{ file: string; entry: OutboxEntry }> {
    const out: Array<{ file: string; entry: OutboxEntry }> = [];
    for (const file of this.files()) {
      try {
        out.push({ file, entry: JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as OutboxEntry });
      } catch {
        // half-written or corrupt: leave it to the flusher, which moves it aside
      }
    }
    return out;
  }

  private enqueue(ops: StoreOp[], reason: OutboxEntry['reason']): void {
    mkdirSync(this.dir, { recursive: true });
    const at = new Date(this.now()).toISOString();
    for (const o of ops) {
      const name = `${this.now()}-${String(process.pid).padStart(7, '0')}-${String(seq++).padStart(6, '0')}.json`;
      const entry: OutboxEntry = { op: o.op, path: o.path, at, reason };
      if (o.data !== undefined) entry.data = o.data;
      // write-then-rename: a reader never sees a half-written entry
      const tmp = join(this.dir, `.${name}.tmp`);
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, join(this.dir, name));
    }
  }

  /** Write through to the store, or queue (see the rules at the top). */
  async write(ops: StoreOp[]): Promise<void> {
    if (ops.length === 0) return;
    const why = this.writeBlock();
    if (why) {
      this.drop(ops.length, why);
      return;
    }
    if (this.pending() > 0) {
      this.enqueue(ops, 'order');
      return;
    }
    try {
      await withTimeout(this.store.apply(ops), this.timeoutMs);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      this.enqueue(ops, e instanceof WriteTimeout ? 'timeout' : 'network');
      this.log(`offline: queued ${ops.length} write(s) (${(e as Error).message})`);
    }
  }

  /** Apply the queue (daemon only). Concurrent calls share one run. */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private moveToFailed(file: string, why: string): void {
    mkdirSync(this.failedDir, { recursive: true });
    try {
      renameSync(join(this.dir, file), join(this.failedDir, file));
    } catch {
      /* already gone */
    }
    this.log(`write refused, moved to failed/${file}: ${why}`);
  }

  private remove(files: string[]): void {
    for (const f of files) {
      try {
        unlinkSync(join(this.dir, f));
      } catch {
        /* already gone */
      }
    }
  }

  private async flushOnce(): Promise<FlushResult> {
    const res: FlushResult = { applied: 0, failed: 0, remaining: 0, offline: false, settling: false };
    const files = this.files();
    if (files.length === 0) return res;
    // Behind on the data format: hold the queue (it is from before; the updated
    // daemon flushes it).
    if (this.writeBlock()) {
      res.remaining = files.length;
      return res;
    }

    // Read; unreadable files are moved aside so they can't block the queue.
    const list: Array<{ file: string; entry: OutboxEntry }> = [];
    for (const file of files) {
      try {
        list.push({ file, entry: JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as OutboxEntry });
      } catch (e) {
        this.moveToFailed(file, `unreadable: ${(e as Error).message}`);
        res.failed++;
      }
    }

    const lastTimeout = list
      .filter((x) => x.entry.reason === 'timeout')
      .reduce((m, x) => Math.max(m, Date.parse(x.entry.at) || 0), 0);
    if (lastTimeout && this.now() - lastTimeout < this.settleMs) {
      res.settling = true;
      res.remaining = list.length;
      return res;
    }

    // Fold per document, in queue order of each document's LAST entry.
    const folded = new Map<string, { op: StoreOp; files: string[] }>();
    for (const { file, entry } of list) {
      const prev = folded.get(entry.path);
      let op: StoreOp;
      if (entry.op === 'merge' && prev && prev.op.op === 'set') {
        op = { op: 'set', path: entry.path, data: { ...(prev.op.data ?? {}), ...(entry.data ?? {}) } };
      } else if (entry.op === 'merge' && prev && prev.op.op === 'merge') {
        op = { op: 'merge', path: entry.path, data: { ...(prev.op.data ?? {}), ...(entry.data ?? {}) } };
      } else {
        op = { op: entry.op, path: entry.path, data: entry.data };
      }
      const filesFor = [...(prev?.files ?? []), file];
      folded.delete(entry.path); // re-insert: Map order = last-entry order
      folded.set(entry.path, { op, files: filesFor });
    }

    const groups = [...folded.values()];
    for (let i = 0; i < groups.length; i += MAX_BATCH) {
      const chunk = groups.slice(i, i + MAX_BATCH);
      try {
        await withTimeout(this.store.apply(chunk.map((g) => g.op)), this.timeoutMs * 2);
        this.remove(chunk.flatMap((g) => g.files));
        res.applied += chunk.length;
        continue;
      } catch (e) {
        if (isNetworkError(e)) {
          res.offline = true;
          break;
        }
      }
      // A refused batch: apply one by one to find the bad write(s).
      for (const g of chunk) {
        try {
          await withTimeout(this.store.apply([g.op]), this.timeoutMs);
          this.remove(g.files);
          res.applied++;
        } catch (e) {
          if (isNetworkError(e)) {
            res.offline = true;
            break;
          }
          for (const f of g.files) this.moveToFailed(f, (e as Error).message);
          res.failed += g.files.length;
        }
      }
      if (res.offline) break;
    }
    res.remaining = this.pending();
    return res;
  }
}

/** Ensure the dir exists (for status readers that count files). */
export function outboxCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}
