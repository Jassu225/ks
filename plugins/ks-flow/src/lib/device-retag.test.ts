// Tests for lib/device-retag.ts against the in-memory DocDb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocDb } from './db/docdb.js';
import { retagDevice } from './device-retag.js';

const NOW = new Date('2026-11-16T10:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function seeded(lastSeen = ago(10)): MemoryDocDb {
  return new MemoryDocDb({
    'devices/good': { deviceId: 'good', lastSeenAt: ago(0) },
    'devices/wrong': { deviceId: 'wrong', lastSeenAt: lastSeen },
    'devices/other': { deviceId: 'other', lastSeenAt: ago(0) },
    'meta/settings': { masterDeviceId: 'good' },
    'workUnits/KAR-1': { unitId: 'KAR-1', deviceId: 'good' },
    'workUnits/KAR-2': { unitId: 'KAR-2', deviceId: 'other' },
    'sessions/s1': { sessionId: 's1', deviceId: 'wrong' },
    'sessions/s2': { sessionId: 's2', deviceId: 'good' },
    'backupRuns/r1': { uid: 'r1', deviceId: 'wrong' },
    'backupUnits/KAR-1': { uid: 'KAR-1', deviceId: 'wrong' },
    'masterEvents/e1': { uid: 'e1', deviceId: 'wrong' },
  });
}

test('retagDevice: moves only the old id\'s docs, deletes its device record', async () => {
  const db = seeded();
  const r = await retagDevice(db, { from: 'wrong', to: 'good', now: () => NOW });
  assert.equal(r.refused, undefined);
  assert.deepEqual(r.retagged, { workUnits: 0, sessions: 1, backupRuns: 1, backupUnits: 1, masterEvents: 1 });
  assert.equal(r.device, 'deleted');
  assert.equal(r.master, false);
  assert.equal((await db.get('sessions/s1'))?.deviceId, 'good');
  assert.equal((await db.get('backupRuns/r1'))?.deviceId, 'good');
  assert.equal((await db.get('workUnits/KAR-2'))?.deviceId, 'other', 'another device untouched');
  assert.equal(await db.get('devices/wrong'), null);
  assert.ok(await db.get('devices/other'));
});

test('retagDevice: dry run writes nothing', async () => {
  const db = seeded();
  const r = await retagDevice(db, { from: 'wrong', to: 'good', dryRun: true, now: () => NOW });
  assert.equal(r.retagged.sessions, 1);
  assert.equal(db.batches.length, 0);
  assert.ok(await db.get('devices/wrong'));
});

test('retagDevice: refuses while the old id still sends heartbeats, for the same id, or an unknown target', async () => {
  assert.match((await retagDevice(seeded(ago(1)), { from: 'wrong', to: 'good', now: () => NOW })).refused ?? '', /heartbeat/);
  assert.match((await retagDevice(seeded(), { from: 'good', to: 'good', now: () => NOW })).refused ?? '', /nothing to move/);
  assert.match((await retagDevice(seeded(), { from: 'wrong', to: 'nobody', now: () => NOW })).refused ?? '', /does not exist/);
});

test('retagDevice: moves the master choice when it named the old id', async () => {
  const db = seeded();
  await db.write([{ op: 'merge', path: 'meta/settings', data: { masterDeviceId: 'wrong' } }]);
  const r = await retagDevice(db, { from: 'wrong', to: 'good', now: () => NOW });
  assert.equal(r.master, true);
  assert.equal((await db.get('meta/settings'))?.masterDeviceId, 'good');
});
