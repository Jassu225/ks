// Tests for lib/db/outbox.ts (offline mode) and the flusher's backoff, against
// a fake store — no Firestore, no emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox, isNetworkError, type DocStore, type OutboxEntry, type StoreOp } from './outbox.js';
import { flushTick, type FlusherState } from './outbox-flusher.js';

/** A fake Firestore: a map of path → doc. `mode` decides how apply() fails. */
class FakeStore implements DocStore {
  docs = new Map<string, Record<string, unknown>>();
  calls: StoreOp[][] = [];
  mode: 'ok' | 'offline' | 'hang' = 'ok';
  /** Paths whose write is refused as bad data. */
  poison = new Set<string>();
  async apply(ops: StoreOp[]): Promise<void> {
    this.calls.push(ops);
    if (this.mode === 'offline') throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    if (this.mode === 'hang') return new Promise(() => {});
    const bad = ops.find((o) => this.poison.has(o.path));
    if (bad) throw Object.assign(new Error('3 INVALID_ARGUMENT: bad doc'), { code: 3 });
    for (const o of ops) {
      if (o.op === 'delete') this.docs.delete(o.path);
      else if (o.op === 'merge') this.docs.set(o.path, { ...(this.docs.get(o.path) ?? {}), ...(o.data ?? {}) });
      else this.docs.set(o.path, { ...(o.data ?? {}) });
    }
  }
}

const quiet = () => {};
function setup(opts: { timeoutMs?: number; settleMs?: number; now?: () => number } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'ksflow-outbox-')), 'outbox');
  const store = new FakeStore();
  const ob = new Outbox(dir, store, { log: quiet, timeoutMs: 50, settleMs: 0, ...opts });
  return { dir, store, ob };
}
const set = (path: string, data: Record<string, unknown>): StoreOp => ({ op: 'set', path, data });
const entries = (dir: string): OutboxEntry[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as OutboxEntry);

test('isNetworkError: gRPC UNAVAILABLE / DEADLINE_EXCEEDED and DNS errors yes; bad data no', () => {
  assert.equal(isNetworkError({ code: 14, message: 'x' }), true);
  assert.equal(isNetworkError({ code: 4, message: 'x' }), true);
  assert.equal(isNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND firestore.googleapis.com'), { code: 'ENOTFOUND' })), true);
  assert.equal(isNetworkError(new Error('request failed', { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isNetworkError({ code: 3, message: '3 INVALID_ARGUMENT: bad doc' }), false);
});

test('online + empty outbox: writes go straight through', async () => {
  const { dir, store, ob } = setup();
  await ob.write([set('reminders/a', { uid: 'a' })]);
  assert.deepEqual(store.docs.get('reminders/a'), { uid: 'a' });
  assert.equal(existsSync(dir), false);
});

test('network error: the write is queued, the caller sees success', async () => {
  const { dir, store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/a', { uid: 'a' })]);
  const q = entries(dir);
  assert.equal(q.length, 1);
  assert.equal(q[0].op, 'set');
  assert.equal(q[0].path, 'reminders/a');
  assert.equal(q[0].reason, 'network');
});

test('a hanging write times out and is queued as reason=timeout', async () => {
  const { dir, store, ob } = setup({ timeoutMs: 20 });
  store.mode = 'hang';
  await ob.write([set('workUnits/u', { unitId: 'u' })]);
  assert.equal(entries(dir)[0].reason, 'timeout');
});

test('bad data is not queued: it throws as before', async () => {
  const { dir, store, ob } = setup();
  store.poison.add('reminders/bad');
  await assert.rejects(ob.write([set('reminders/bad', { uid: 'bad' })]), /INVALID_ARGUMENT/);
  assert.equal(existsSync(dir), false);
});

test('ordering: while the outbox holds anything, new writes are queued, not written', async () => {
  const { dir, store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/a', { v: 1 })]);
  store.mode = 'ok'; // back online, but the queue is not empty
  await ob.write([set('reminders/a', { v: 2 })]);
  assert.equal(store.docs.has('reminders/a'), false);
  assert.deepEqual(
    entries(dir).map((e) => [e.reason, e.data?.v]),
    [
      ['network', 1],
      ['order', 2],
    ],
  );
  const r = await ob.flush();
  assert.equal(r.applied, 1);
  assert.deepEqual(store.docs.get('reminders/a'), { v: 2 }); // newest wins
  assert.equal(ob.pending(), 0);
});

test('flush coalesces per document: last set wins, a merge folds into the set before it, a delete removes', async () => {
  const { store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('sessions/s', { sessionId: 's', n: 1 })]);
  await ob.write([set('sessions/s', { sessionId: 's', n: 2 })]);
  await ob.write([{ op: 'merge', path: 'sessions/s', data: { archived: true } }]);
  await ob.write([set('reminders/x', { uid: 'x' })]);
  await ob.write([{ op: 'delete', path: 'reminders/x' }]);
  store.mode = 'ok';
  store.calls = [];
  const r = await ob.flush();
  assert.equal(r.applied, 2); // two documents
  assert.equal(store.calls.length, 1); // one batch
  assert.deepEqual(store.docs.get('sessions/s'), { sessionId: 's', n: 2, archived: true });
  assert.equal(store.docs.has('reminders/x'), false);
  assert.equal(ob.pending(), 0);
});

test('flush stops on a network failure and keeps every entry', async () => {
  const { store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/a', { v: 1 })]);
  await ob.write([set('reminders/b', { v: 1 })]);
  const r = await ob.flush();
  assert.equal(r.offline, true);
  assert.equal(r.applied, 0);
  assert.equal(ob.pending(), 2);
});

test('a refused (poison) write moves to failed/ and does not block the rest', async () => {
  const { dir, store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/bad', { v: 1 })]);
  await ob.write([set('reminders/good', { v: 1 })]);
  store.mode = 'ok';
  store.poison.add('reminders/bad');
  const r = await ob.flush();
  assert.equal(r.failed, 1);
  assert.equal(r.applied, 1);
  assert.deepEqual(store.docs.get('reminders/good'), { v: 1 });
  assert.equal(ob.pending(), 0);
  assert.equal(readdirSync(join(dir, 'failed')).filter((f) => f.endsWith('.json')).length, 1);
});

test('an unreadable file moves to failed/', async () => {
  const { dir, store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/a', { v: 1 })]);
  writeFileSync(join(dir, '0000000000000-0000001-000000.json'), '{not json');
  store.mode = 'ok';
  const r = await ob.flush();
  assert.equal(r.failed, 1);
  assert.equal(r.applied, 1);
  assert.equal(ob.pending(), 0);
});

test('a timed-out write is not flushed until it has settled (it may still land late)', async () => {
  let now = 1_000_000;
  const { store, ob } = setup({ timeoutMs: 20, settleMs: 70_000, now: () => now });
  store.mode = 'hang';
  await ob.write([set('workUnits/u', { v: 1 })]);
  store.mode = 'ok';
  let r = await ob.flush();
  assert.equal(r.settling, true);
  assert.equal(ob.pending(), 1);
  now += 71_000;
  r = await ob.flush();
  assert.equal(r.applied, 1);
  assert.equal(ob.pending(), 0);
});

test('flusher: backs off after a network failure, resets after success', async () => {
  const { store, ob } = setup();
  store.mode = 'offline';
  await ob.write([set('reminders/a', { v: 1 })]);
  const st: FlusherState = { backoffMs: 0, nextAt: 0 };
  await flushTick(ob, st, 0, quiet);
  assert.equal(st.backoffMs, 30_000);
  assert.equal(await flushTick(ob, st, 10_000, quiet), null); // still backing off
  await flushTick(ob, st, 30_000, quiet);
  assert.equal(st.backoffMs, 60_000);
  store.mode = 'ok';
  const r = await flushTick(ob, st, 90_000, quiet);
  assert.equal(r?.applied, 1);
  assert.equal(st.backoffMs, 0);
  assert.equal(await flushTick(ob, st, 91_000, quiet), null); // nothing queued
});
