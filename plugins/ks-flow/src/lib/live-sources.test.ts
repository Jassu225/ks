import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import { liveSources } from './live-sources.js';

function seeded(): MemoryDocDb {
  return new MemoryDocDb({
    'meta/settings': { masterDeviceId: 'dev-a' },
    'devices/dev-a': { defaultName: 'A' },
    'devices/dev-b': { defaultName: 'B' },
    'workUnits/KAR-1': { unitId: 'KAR-1', deviceId: 'dev-a' },
    'workUnits/KAR-2': { unitId: 'KAR-2', deviceId: 'dev-b' },
    'reminders/r1': { uid: 'r1', kind: 'note' },
    'briefingItems/i1': { uid: 'i1', status: 'open' },
    'briefingItems/i2': { uid: 'i2', status: 'archived' },
    'backupRuns/old': { uid: 'old', startedAt: '2026-11-01T00:00:00Z' },
    'backupRuns/new': { uid: 'new', startedAt: '2026-11-16T00:00:00Z' },
    'backupUnits/u1': { identifier: 'KAR-1' },
    'masterRequests/m1': { trigger: 'button', from: 'dev-b', createdAt: '2026-11-17T11:59:00Z' },
  });
}

function first<T>(spec: { attach: (d: (v: T) => void, e: (err: Error) => void) => () => void }): T {
  let got: T | undefined;
  const stop = spec.attach(
    (v) => (got ??= v),
    () => {},
  );
  stop();
  assert.ok(got !== undefined);
  return got as T;
}

test('liveSources: null where the store cannot listen', () => {
  const db = seeded();
  const store = docDeviceStore(db);
  assert.equal(liveSources(undefined, store, 'dev-a'), null);
});

test('liveSources: each listener sees what its job reads', () => {
  const db = seeded();
  const src = liveSources(db, docDeviceStore(db), 'dev-a')!;
  assert.equal(first(src.settings)?.masterDeviceId, 'dev-a');
  assert.deepEqual(first(src.devices).map((d) => d.deviceId), ['dev-a', 'dev-b']);
  assert.deepEqual(first(src.foreignCards), [{ unitId: 'KAR-2', deviceId: 'dev-b' }]);
  assert.deepEqual(first(src.reminders).map((r) => r.uid), ['r1']);
  assert.deepEqual(first(src.openItems).map((i) => i.uid), ['i1'], 'only open items');
  assert.deepEqual(first(src.backupRuns).map((r) => r.uid), ['new', 'old'], 'newest first');
  assert.deepEqual(first(src.backupUnits).map((u) => u.uid), ['u1'], 'uid from the doc id');
  assert.deepEqual(first(src.masterRequests).map((r) => r.uid), ['m1']);
});
