// Tests for lib/device-backfill.ts against the in-memory DocDb (lib/db/docdb.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import { backfillDevices, sharedBlocks, type BackfillOptions } from './device-backfill.js';

const NOW = new Date('2026-11-16T10:00:00Z');
const opts = (extra: Partial<BackfillOptions> = {}): BackfillOptions => ({
  deviceId: 'dev-a',
  defaultName: 'Laptop A',
  platform: 'darwin',
  shared: { briefing: { enabled: true }, gcsArchive: { enabled: true } },
  now: () => NOW,
  ...extra,
});

function seeded(): MemoryDocDb {
  return new MemoryDocDb({
    'meta/project': {
      projectId: 'p',
      projectPath: '/repo',
      commonDir: '/repo/.git',
      workflowType: 'ticket',
      phaseModel: [{ number: 1, name: 'x' }],
      worktreePaths: ['/repo', '/wt/KAR-1'],
      inboxUrl: 'http://localhost:19432',
      inboxRunning: true,
      linearCheckedAt: '2026-11-16T09:00:00Z',
      updatedAt: 'x',
    },
    'workUnits/KAR-1': { unitId: 'KAR-1', title: 'one', worktreeDir: '/wt/KAR-1' },
    'workUnits/KAR-2': { unitId: 'KAR-2', title: 'two', deviceId: 'dev-b' },
    'sessions/s1': { sessionId: 's1', inProject: true },
    'backupRuns/r1': { uid: 'r1', startedAt: 'x' },
    'backupUnits/KAR-1': { uid: 'KAR-1' },
    'masterEvents/e1': { uid: 'e1', at: 'x' },
    'reminders/n1': { uid: 'n1', kind: 'note' },
  });
}

test('sharedBlocks keeps the shared blocks only', () => {
  assert.deepEqual(
    sharedBlocks({ briefing: { enabled: true }, removeCommand: 'x', notes: { enabled: false }, reminders: 3 }),
    { briefing: { enabled: true }, notes: { enabled: false } },
  );
  assert.deepEqual(sharedBlocks(null), {});
});

test('backfill: tags untagged docs, claims meta/settings, moves meta/project into devices/{self}', async () => {
  const db = seeded();
  const res = await backfillDevices(db, opts());
  assert.equal(res.refused, null);
  assert.deepEqual(res.tagged, { workUnits: 1, sessions: 1, backupRuns: 1, backupUnits: 1, masterEvents: 1 });
  assert.equal(res.alreadyTagged.workUnits, 1);
  assert.equal(res.project, 'copied');

  assert.equal((await db.get('workUnits/KAR-1'))!.deviceId, 'dev-a');
  assert.equal((await db.get('workUnits/KAR-1'))!.title, 'one', 'a merge: the rest of the card stays');
  assert.equal((await db.get('workUnits/KAR-2'))!.deviceId, 'dev-b', 'an owned card keeps its owner');
  for (const p of ['sessions/s1', 'backupRuns/r1', 'backupUnits/KAR-1', 'masterEvents/e1']) {
    assert.equal((await db.get(p))!.deviceId, 'dev-a', p);
  }
  assert.equal((await db.get('reminders/n1'))!.deviceId, undefined, 'shared collections are not tagged');

  const store = docDeviceStore(db);
  const settings = await store.getSettings();
  assert.equal(settings!.masterDeviceId, 'dev-a');
  assert.deepEqual(settings!.briefing, { enabled: true });
  assert.equal(settings!.backfill!.state, 'done');
  assert.equal(settings!.backfill!.by, 'dev-a');

  const dev = await store.getDevice('dev-a');
  assert.deepEqual(dev, {
    deviceId: 'dev-a',
    defaultName: 'Laptop A',
    platform: 'darwin',
    projectPath: '/repo',
    commonDir: '/repo/.git',
    worktreePaths: ['/repo', '/wt/KAR-1'],
    inboxUrl: 'http://localhost:19432',
    inboxRunning: true,
    linearCheckedAt: '2026-11-16T09:00:00Z',
  });
  assert.equal(await db.get('meta/project'), null, 'meta/project is deleted');
});

test('backfill runs once: a second run (any device) refuses and writes nothing', async () => {
  const db = seeded();
  await backfillDevices(db, opts());
  const before = db.batches.length;
  const again = await backfillDevices(db, opts());
  assert.match(again.refused!, /already exists/);
  const other = await backfillDevices(db, opts({ deviceId: 'dev-b' }));
  assert.match(other.refused!, /dev-a/);
  assert.equal(db.batches.length, before);
});

test('backfill refuses on a store whose meta/settings was not made by a backfill', async () => {
  const db = seeded();
  await db.create('meta/settings', { masterDeviceId: 'dev-x' });
  const res = await backfillDevices(db, opts());
  assert.match(res.refused!, /already set up/);
  assert.equal(db.batches.length, 0);
});

test('backfill: merge ops in chunks of at most 500 (and the chunk option)', async () => {
  const seed: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 1203; i++) seed[`sessions/s${i}`] = { sessionId: `s${i}` };
  const db = new MemoryDocDb(seed);
  const res = await backfillDevices(db, opts({ chunk: 10_000 }));
  assert.equal(res.tagged.sessions, 1203);
  const tagBatches = db.batches.filter((b) => b.every((o) => o.path.startsWith('sessions/')));
  assert.deepEqual(tagBatches.map((b) => b.length), [500, 500, 203]);
  assert.ok(tagBatches.every((b) => b.every((o) => o.op === 'merge' && (o.data as { deviceId: string }).deviceId === 'dev-a')));
  assert.equal(res.batches, 3);

  const db2 = new MemoryDocDb({ 'masterEvents/a': {}, 'masterEvents/b': {}, 'masterEvents/c': {} });
  const r2 = await backfillDevices(db2, opts({ chunk: 2 }));
  assert.equal(r2.batches, 2);
});

test('backfill --dry-run counts and writes nothing', async () => {
  const db = seeded();
  const res = await backfillDevices(db, opts({ dryRun: true }));
  assert.equal(res.dryRun, true);
  assert.equal(res.tagged.workUnits, 1);
  assert.equal(res.project, 'copied');
  assert.equal(db.batches.length, 0);
  assert.equal(await db.get('meta/settings'), null);
  assert.notEqual(await db.get('meta/project'), null);
});

test('backfill resumes its own unfinished run, and no other', async () => {
  const db = seeded();
  await db.create('meta/settings', { masterDeviceId: 'dev-a', backfill: { by: 'dev-a', startedAt: 'T0', state: 'running' } });
  const other = await backfillDevices(db, opts({ deviceId: 'dev-b' }));
  assert.match(other.refused!, /running/);
  const res = await backfillDevices(db, opts());
  assert.equal(res.refused, null);
  assert.equal(res.resumed, true);
  const s = await docDeviceStore(db).getSettings();
  assert.equal(s!.backfill!.state, 'done');
  assert.equal(s!.backfill!.startedAt, 'T0');
  assert.equal((await db.get('workUnits/KAR-1'))!.deviceId, 'dev-a');
});

test('backfill without meta/project still records the device', async () => {
  const db = new MemoryDocDb({ 'workUnits/KAR-9': { unitId: 'KAR-9' } });
  const res = await backfillDevices(db, opts());
  assert.equal(res.project, 'none');
  assert.deepEqual(await docDeviceStore(db).getDevice('dev-a'), { deviceId: 'dev-a', defaultName: 'Laptop A', platform: 'darwin' });
});
