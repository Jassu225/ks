// lib/live-mirror.ts — the daemon's live copies of the store (Firestore listeners).
//
// No job reads Firestore on a timer: each collection a job needs is followed by
// one snapshot listener, kept here, and the jobs read its latest data from
// memory. A listener costs one read per doc when it attaches and one per changed
// doc after that, so an idle store costs nothing.
//
// Firestore reconnects a listener by itself through short network drops, but an
// error (a refused query, credentials, too many retries while offline) ends it
// for good. The daemon's one 15 s clock calls ensure(): a failed listener is
// attached again after a backoff (15 s, 30 s, 1 min … 15 min), a healthy one
// costs nothing. Each failure and each recovery is reported (onFail / onRecover:
// the errors log, lib/errors-log.ts, and a macOS notice).
//
// The last data stays readable while a listener is down (`live` says whether it
// is current). Where the store has no listeners (PocketBase, a local server),
// nothing is added here and the jobs read the store directly.
import type { Unsubscribe } from './db/types.js';

export interface LiveSpec<T> {
  /** Stable key: `listener:<name>` in the errors log. */
  name: string;
  /** What it follows, for people ("Reminders", "Shared settings"). */
  label: string;
  /** Start the listener: onData with every snapshot, onError once when it stops. */
  attach(onData: (value: T) => void, onError: (e: Error) => void): Unsubscribe;
}

export type LiveState = 'off' | 'connecting' | 'live' | 'failed';

export interface LiveStatus {
  name: string;
  label: string;
  state: LiveState;
  /** The last error, while failed (kept until the next snapshot). */
  error: string | null;
  /** Failures since the last snapshot (drives the backoff). */
  failures: number;
  /** When the last snapshot arrived (ms), or null. */
  dataAt: number | null;
  /** While failed: when ensure() attaches it again (ms). */
  retryAt: number | null;
}

export interface LiveHandle<T> {
  /** The latest snapshot (kept while the listener is down), or undefined before the first. */
  get(): T | undefined;
  /** Has a snapshot arrived since the last attach (the data is current)? */
  live(): boolean;
}

export interface MirrorHooks {
  now?: () => number;
  /** A listener stopped (or could not start). `retryAt`: when it is tried again. */
  onFail?(s: LiveStatus): void;
  /** A listener that had failed delivered data again, or was turned off while failed. */
  onRecover?(s: LiveStatus): void;
  /** The first snapshot after each attach (the daemon also clears problems left open by an earlier run). */
  onLive?(s: LiveStatus): void;
}

const BASE_MS = 15_000;
const MAX_MS = 15 * 60_000;

/** Wait before attach #n+1 after `failures` failures in a row: 15 s doubling, at most 15 min. */
export function backoffMs(failures: number): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, failures - 1), MAX_MS);
}

interface Entry {
  spec: LiveSpec<unknown>;
  wanted: boolean;
  state: LiveState;
  unsub: Unsubscribe | null;
  /** Bumped on every attach and detach: callbacks of an older listener are ignored. */
  gen: number;
  value: unknown;
  hasValue: boolean;
  error: string | null;
  failures: number;
  dataAt: number | null;
  retryAt: number | null;
  /** It failed since its last snapshot: the next snapshot is a recovery. */
  down: boolean;
}

export class LiveMirror {
  private entries = new Map<string, Entry>();
  private now: () => number;

  constructor(private hooks: MirrorHooks = {}) {
    this.now = hooks.now ?? Date.now;
  }

  /** Register a listener (wanted: attached by the next ensure(); `want(name, false)` keeps it off). */
  add<T>(spec: LiveSpec<T>, wanted = true): LiveHandle<T> {
    if (this.entries.has(spec.name)) throw new Error(`live mirror: ${spec.name} added twice`);
    const e: Entry = {
      spec: spec as LiveSpec<unknown>,
      wanted,
      state: 'off',
      unsub: null,
      gen: 0,
      value: undefined,
      hasValue: false,
      error: null,
      failures: 0,
      dataAt: null,
      retryAt: null,
      down: false,
    };
    this.entries.set(spec.name, e);
    return {
      get: () => (e.hasValue ? (e.value as T) : undefined),
      live: () => e.state === 'live',
    };
  }

  /** Turn one listener on or off (the master device's listeners follow masterDeviceId). */
  want(name: string, on: boolean): void {
    const e = this.entries.get(name);
    if (!e || e.wanted === on) return;
    e.wanted = on;
    if (on) {
      this.attach(e);
      return;
    }
    this.detach(e, true);
    // Not needed any more: its failure is no longer a problem.
    if (e.down) {
      e.down = false;
      e.error = null;
      e.failures = 0;
      this.hooks.onRecover?.(this.statusOf(e));
    }
  }

  /**
   * The clock's call (every tick, and once at start): attach every wanted
   * listener that is off, and every failed one whose backoff has passed.
   * Healthy listeners are left alone.
   */
  ensure(): void {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (!e.wanted) continue;
      if (e.state === 'off') this.attach(e);
      else if (e.state === 'failed' && (e.retryAt ?? 0) <= now) this.attach(e);
    }
  }

  status(): LiveStatus[] {
    return [...this.entries.values()].map((e) => this.statusOf(e));
  }

  stopAll(): void {
    for (const e of this.entries.values()) this.detach(e, true);
  }

  private statusOf(e: Entry): LiveStatus {
    return {
      name: e.spec.name,
      label: e.spec.label,
      state: e.state,
      error: e.error,
      failures: e.failures,
      dataAt: e.dataAt,
      retryAt: e.retryAt,
    };
  }

  private attach(e: Entry): void {
    this.detach(e, false);
    const gen = ++e.gen;
    e.state = 'connecting';
    e.retryAt = null;
    try {
      const unsub = e.spec.attach(
        (value) => {
          if (gen !== e.gen) return;
          const first = e.state !== 'live';
          e.value = value;
          e.hasValue = true;
          e.dataAt = this.now();
          e.state = 'live';
          e.error = null;
          e.failures = 0;
          if (e.down) {
            e.down = false;
            this.hooks.onRecover?.(this.statusOf(e));
          }
          if (first) this.hooks.onLive?.(this.statusOf(e));
        },
        (err) => {
          if (gen !== e.gen) return;
          this.fail(e, err);
        },
      );
      // A listener that failed synchronously inside attach() has already moved on.
      if (gen === e.gen) e.unsub = unsub;
      else unsub();
    } catch (err) {
      if (gen === e.gen) this.fail(e, err as Error);
    }
  }

  private fail(e: Entry, err: Error): void {
    this.detach(e, false);
    e.gen++;
    e.state = 'failed';
    e.failures++;
    e.down = true;
    e.error = err?.message ?? String(err);
    e.retryAt = this.now() + backoffMs(e.failures);
    this.hooks.onFail?.(this.statusOf(e));
  }

  private detach(e: Entry, off: boolean): void {
    const unsub = e.unsub;
    e.unsub = null;
    if (unsub) {
      try {
        unsub();
      } catch {
        /* already stopped */
      }
    }
    if (off) {
      e.gen++;
      e.state = 'off';
      e.retryAt = null;
    }
  }
}
