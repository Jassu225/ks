// Tests for lib/master-device.ts (gating, masterRequests expiry and queue) and
// the master status read ported into lib/master.ts, against the in-memory DocDb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import type { MasterRequestDoc } from './db/types.js';
import { isMasterDevice, MasterRequestQueue, requestExpired } from './master-device.js';
import { masterStatusOf, masterStatusSig, readMasterStatus, takeStartRequest, writeStartRequest } from './master.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const BRIEFING = { enabled: true, schedule: ['06:00'] };

test('isMasterDevice: only the chosen device; every device before the backfill', () => {
  assert.equal(isMasterDevice({ masterDeviceId: 'dev-a' }, 'dev-a', true), true);
  assert.equal(isMasterDevice({ masterDeviceId: 'dev-a' }, 'dev-b', true), false);
  assert.equal(isMasterDevice({ masterDeviceId: 'dev-a' }, 'dev-c', true), false);
  assert.equal(isMasterDevice(null, 'dev-b', false), true); // no meta/settings: as today
  assert.equal(isMasterDevice({ masterDeviceId: 'dev-a' }, 'dev-b', false), true); // device mode off
});

test('requestExpired: older than 15 min (or no readable time) is dropped', () => {
  assert.equal(requestExpired({ createdAt: ago(14 * 60_000) }, NOW), false);
  assert.equal(requestExpired({ createdAt: ago(15 * 60_000 + 1) }, NOW), true);
  assert.equal(requestExpired({ createdAt: 'garbage' }, NOW), true);
});

test('MasterRequestQueue: each request handled once, expired ones flagged, all deleted', async () => {
  const db = new MemoryDocDb({
    'masterRequests/r1': { uid: 'r1', trigger: 'button', from: 'dev-b', createdAt: ago(60_000) },
    'masterRequests/r2': { uid: 'r2', trigger: 'start', from: 'dev-c', createdAt: ago(20 * 60_000) },
    'masterRequests/r3': { uid: 'r3', trigger: 'restart', from: 'dev-c', createdAt: ago(30_000) },
  });
  const store = docDeviceStore(db);
  const seen: Array<[string, boolean]> = [];
  const q = new MasterRequestQueue(store, (req, expired) => {
    seen.push([req.uid, expired]);
  });
  // A listener delivery and a tick at the same moment: still one handling each.
  const fromWatch = await store.getMasterRequests();
  const [a, b] = await Promise.all([q.take(fromWatch, () => NOW), q.take(undefined, () => NOW)]);
  assert.deepEqual(seen, [
    ['r2', true],
    ['r1', false],
    ['r3', false],
  ]);
  assert.deepEqual(a.expired, ['r2']);
  assert.deepEqual(a.handled, ['r1', 'r3']);
  assert.deepEqual(b, { handled: [], expired: [] });
  assert.deepEqual(await store.getMasterRequests(), []);
});

test('MasterRequestQueue: a failing handler still deletes the doc; the listener drives it', async () => {
  const db = new MemoryDocDb();
  const store = docDeviceStore(db);
  const logs: string[] = [];
  const handled: string[] = [];
  const q = new MasterRequestQueue(
    store,
    (req) => {
      handled.push(req.uid);
      if (req.uid === 'bad') throw new Error('boom');
    },
    (m) => logs.push(m),
  );
  const passes: Array<Promise<unknown>> = [];
  const stop = store.watchMasterRequests!((list) => passes.push(q.take(list, () => NOW)));
  const req: MasterRequestDoc = { uid: 'bad', trigger: 'button', from: 'dev-b', createdAt: ago(1000) };
  await store.addMasterRequest(req);
  await Promise.all(passes);
  await Promise.all(passes); // the delete re-fires the listener with an empty list
  stop();
  assert.deepEqual(handled, ['bad']);
  assert.equal(db.docs.has('masterRequests/bad'), false);
  assert.match(logs.join('\n'), /failed \(boom\)/);
});

test('masterStatusOf: the board states; a heartbeat of another session does not count', () => {
  const session = { v: 1 as const, sessionId: 's1', pid: 77, tmuxPane: '%1', cwd: '/x', startedAt: ago(3_600_000), handoff: null };
  const base = { now: NOW, session, bridgeSessionId: 'br-1', pending: [], briefing: BRIEFING };
  const live = masterStatusOf({ ...base, pid: 77, heartbeat: { sessionId: 's1', at: ago(10_000), busy: false } });
  assert.equal(live.state, 'live');
  assert.equal(live.heartbeatAgeMs, 10_000);
  assert.equal(live.heartbeatAt, ago(10_000));
  assert.equal(live.bridgeSessionId, 'br-1');
  assert.equal(masterStatusOf({ ...base, pid: 77, heartbeat: { sessionId: 's1', at: ago(10_000), busy: true } }).state, 'busy');
  assert.equal(masterStatusOf({ ...base, pid: 77, heartbeat: { sessionId: 'old', at: ago(10_000), busy: false } }).state, 'stale');
  const down = masterStatusOf({ ...base, pid: null, heartbeat: null });
  assert.equal(down.state, 'down');
  assert.equal(down.bridgeSessionId, null);
  const starting = masterStatusOf({ ...base, session: { ...session, pid: null, startedAt: ago(60_000) }, pid: null, heartbeat: null });
  assert.equal(starting.state, 'starting');
  const none = masterStatusOf({ ...base, session: null, pid: null, heartbeat: null });
  assert.equal(none.state, 'none');
  // Every field present (devices/{id}.master is written whole, nulls included).
  for (const k of ['state', 'session', 'heartbeat', 'alive', 'heartbeatAgeMs', 'bridgeSessionId', 'pending', 'briefing', 'heartbeatAt', 'pid', 'publishedAt'])
    assert.ok(k in none, k);
  // The signature ignores the age and the read time.
  const later = masterStatusOf({ ...base, now: NOW + 5000, pid: 77, heartbeat: { sessionId: 's1', at: ago(10_000), busy: false } });
  assert.equal(masterStatusSig(later), masterStatusSig(live));
});

test('readMasterStatus + writeStartRequest: files in, status out; a remote start names its device', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksflow-master-'));
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ v: 1, sessionId: 's1', pid: 4242, tmuxPane: null, cwd: '/x', startedAt: ago(3_600_000), handoff: null }),
  );
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ sessionId: 's1', at: ago(5000), busy: false }));
  mkdirSync(join(dir, 'requests'));
  writeFileSync(join(dir, 'requests', `${ago(1000)}-button.json`), JSON.stringify({ trigger: 'button', createdAt: ago(1000) }));
  const st = readMasterStatus(dir, { now: NOW, briefing: BRIEFING, isClaude: (pid) => pid === 4242 });
  assert.equal(st.state, 'live');
  assert.equal(st.pid, 4242);
  assert.deepEqual(st.pending, [`${ago(1000)}-button.json`]);
  writeStartRequest(dir, { by: 'board', from: 'Laptop B' });
  const press = takeStartRequest(dir);
  assert.equal(press?.by, 'board');
  assert.equal(press?.from, 'Laptop B');
  assert.equal(takeStartRequest(dir), null);
});
