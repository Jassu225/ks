// lib/db/outbox-flusher.ts — the daemon's side of offline mode: drains the
// outbox (lib/db/outbox.ts) into Firestore. Only the daemon runs it (it is
// always on); every other writer just appends.
//
// A cheap check every CHECK_MS (a directory listing): while anything is queued
// and we are not backing off, flush. A network failure backs off
// BACKOFF_MIN_MS, doubling to BACKOFF_MAX_MS; a successful pass resets it.
import type { FlushResult, Outbox } from './outbox.js';

const CHECK_MS = 5_000;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface FlusherState {
  backoffMs: number;
  nextAt: number;
}

/** One check (exported for tests): flush when due, then update the backoff. */
export async function flushTick(
  outbox: Outbox,
  st: FlusherState,
  now: number,
  log: (...a: unknown[]) => void,
): Promise<FlushResult | null> {
  if (now < st.nextAt || outbox.pending() === 0) return null;
  const r = await outbox.flush();
  if (r.offline) {
    st.backoffMs = st.backoffMs ? Math.min(st.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    st.nextAt = now + st.backoffMs;
  } else {
    st.backoffMs = 0;
    st.nextAt = 0;
  }
  if (r.applied || r.failed) {
    log(`outbox: applied ${r.applied}, failed ${r.failed}, ${r.remaining} left${r.offline ? ' (offline, retry later)' : ''}`);
  }
  return r;
}

export function startOutboxFlusher(outbox: Outbox, log: (...a: unknown[]) => void): () => void {
  const st: FlusherState = { backoffMs: 0, nextAt: 0 };
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    flushTick(outbox, st, Date.now(), log)
      .catch((e) => log('outbox flush failed', (e as Error)?.message))
      .finally(() => {
        busy = false;
      });
  }, CHECK_MS);
  timer.unref?.();
  const n = outbox.pending();
  if (n) log(`outbox: ${n} write(s) waiting to sync`);
  return () => clearInterval(timer);
}
