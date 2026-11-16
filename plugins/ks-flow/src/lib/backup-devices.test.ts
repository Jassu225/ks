// Tests for the per-device backup rules (lib/backup-runs.ts, archive-index.ts
// reindexOwner) and the local reminder memory (lib/reminders-fired.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeRun, doneSweeps, lastSweepAt, listRuns, runStatus, sweptOn, type BackupRun } from './backup-runs.js';
import { reindexOwner } from './archive-index.js';
import type { BackupRunDoc, BackupStore } from './db/types.js';
import { DAY_MS, lastFired, pruneFired, readFired, recordFired, shouldFire, writeFired } from './reminders-fired.js';

const NOW = Date.parse('2026-11-16T23:50:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(p: Partial<BackupRunDoc> & { uid: string }): BackupRunDoc {
  return { startedAt: ago(60_000), trigger: 'daily', scope: 'all live worktrees', pid: 4242, ...p } as BackupRunDoc;
}

const store = (docs: BackupRunDoc[]): BackupStore =>
  ({ getBackupRuns: async () => docs }) as unknown as BackupStore;

test('runStatus: this device checks the pid; another device is running only while its heartbeat is fresh', () => {
  const alive = (pid: number) => pid === 4242;
  const ctx = { self: 'dev-a', alive, now: NOW, lastSeen: { 'dev-b': ago(60_000), 'dev-c': ago(20 * 60_000) } };
  assert.equal(runStatus(run({ uid: '1', deviceId: 'dev-a' }), ctx), 'running');
  assert.equal(runStatus(run({ uid: '2', deviceId: 'dev-a', pid: 1 }), ctx), 'interrupted');
  // dev-b's pid 1 means nothing here: its fresh heartbeat says running.
  assert.equal(runStatus(run({ uid: '3', deviceId: 'dev-b', pid: 1 }), ctx), 'running');
  // dev-c asleep for 20 min: its unfinished run is interrupted, even if pid 4242 lives here.
  assert.equal(runStatus(run({ uid: '4', deviceId: 'dev-c' }), ctx), 'interrupted');
  // An unknown device (no heartbeat) too.
  assert.equal(runStatus(run({ uid: '5', deviceId: 'dev-x' }), ctx), 'interrupted');
  // An ended run is its outcome, whoever ran it.
  assert.equal(runStatus(run({ uid: '6', deviceId: 'dev-c', outcome: 'ok' }), ctx), 'ok');
  // Untagged (before the backfill) = this device's.
  assert.equal(runStatus(run({ uid: '7' }), ctx), 'running');
});

test('activeRun / lastSweptToday count only this device; another device sweeping never blocks or covers this one', async () => {
  const runs = await listRuns(
    store([
      run({ uid: 'b-running', deviceId: 'dev-b', startedAt: ago(30_000) }),
      run({ uid: 'b-ok', deviceId: 'dev-b', startedAt: ago(3_600_000), outcome: 'ok', endedAt: ago(3_500_000) }),
      run({ uid: 'a-unit', deviceId: 'dev-a', trigger: 'unit', startedAt: ago(7_200_000), outcome: 'ok', endedAt: ago(7_100_000) }),
    ]),
    'p',
    { self: 'dev-a', alive: () => false, now: NOW, lastSeen: new Map([['dev-b', ago(10_000)]]) },
  );
  assert.equal(runs[0].uid, 'b-running');
  assert.equal(runs[0].status, 'running');
  assert.equal(activeRun(runs, 'dev-a'), null);
  assert.equal(activeRun(runs, 'dev-b')?.uid, 'b-running');
  const day = (iso: string) => iso.slice(0, 10);
  assert.equal(sweptOn(runs, '2026-11-16', day, 'dev-a'), false); // B's sweep and A's one-card backup don't count
  assert.equal(sweptOn(runs, '2026-11-16', day, 'dev-b'), true);
  assert.deepEqual(doneSweeps(runs, 'dev-b').map((r) => r.uid), ['b-ok']);
  assert.equal(lastSweepAt(runs, 'dev-a'), ago(7_100_000));
  assert.equal(lastSweepAt(runs), ago(3_500_000)); // no device given: every run
  // One device (no self): every run counts, as before.
  assert.equal(sweptOn(runs as BackupRun[], '2026-11-16', day), true);
});

test('reindexOwner: keeps the stored owner, else the device with the live worktree, else none', () => {
  const devices = [
    { deviceId: 'dev-a', worktreePaths: ['/a/KAR-1'] },
    { deviceId: 'dev-b', worktreePaths: ['/b/KAR-2'] },
    { deviceId: 'dev-c', worktreePaths: ['/c/KAR-3'], forgotten: true },
  ];
  const base = { self: 'dev-a', devices, liveHere: false };
  assert.equal(reindexOwner({ ...base, existing: 'dev-b', liveHere: true, worktreePath: '/a/KAR-1' }), 'dev-b');
  assert.equal(reindexOwner({ ...base, existing: undefined, liveHere: true, worktreePath: '/a/KAR-1' }), 'dev-a');
  assert.equal(reindexOwner({ ...base, existing: undefined, worktreePath: '/b/KAR-2' }), 'dev-b');
  assert.equal(reindexOwner({ ...base, existing: undefined, worktreePath: '/c/KAR-3' }), undefined);
  assert.equal(reindexOwner({ ...base, existing: undefined, worktreePath: '/gone/KAR-9' }), undefined);
});

test('reminders-fired: fires once at due, not again the same day, again after a day', () => {
  const r = { uid: 'r1', dueAt: ago(60_000) };
  let map = {};
  assert.equal(shouldFire(r, map, NOW), true);
  map = recordFired(map, r, NOW);
  assert.equal(shouldFire(r, map, NOW + 30_000), false);
  assert.equal(shouldFire(r, map, NOW + DAY_MS - 1), false);
  assert.equal(shouldFire(r, map, NOW + DAY_MS), true);
  // Wake from sleep and a daemon start re-fire, as before.
  assert.equal(shouldFire(r, map, NOW + 30_000, { wake: true }), true);
  assert.equal(shouldFire(r, map, NOW + 30_000, { startup: true }), true);
  // Not yet due: never.
  assert.equal(shouldFire({ uid: 'r2', dueAt: new Date(NOW + 60_000).toISOString() }, {}, NOW), false);
});

test('reminders-fired: a changed dueAt re-arms; a missing entry starts from the doc\'s old lastFiredAt', () => {
  const r = { uid: 'r1', dueAt: ago(3_600_000) };
  const map = recordFired({}, r, NOW - 60_000);
  const moved = { uid: 'r1', dueAt: ago(60_000) };
  assert.equal(lastFired(moved, map), null);
  assert.equal(shouldFire(moved, map, NOW), true);
  // Upgrade: the doc says it fired an hour ago, the file has nothing → no repeat today.
  const legacy = { uid: 'r9', dueAt: ago(7_200_000), lastFiredAt: ago(3_600_000) };
  assert.equal(shouldFire(legacy, {}, NOW), false);
  assert.equal(shouldFire(legacy, {}, NOW + DAY_MS), true);
  // The local entry wins over the doc once there is one.
  const after = recordFired({}, legacy, NOW + DAY_MS);
  assert.equal(shouldFire(legacy, after, NOW + DAY_MS + 60_000), false);
});

test('reminders-fired: each device keeps its own file (every device notifies); prune drops deleted reminders', () => {
  const a = mkdtempSync(join(tmpdir(), 'ksflow-fired-a-'));
  const b = mkdtempSync(join(tmpdir(), 'ksflow-fired-b-'));
  const r = { uid: 'shared', dueAt: ago(60_000) };
  writeFired(a, recordFired(readFired(a), r, NOW));
  assert.equal(shouldFire(r, readFired(a), NOW + 1000), false);
  assert.equal(shouldFire(r, readFired(b), NOW + 1000), true); // device B still notifies
  const p = pruneFired(readFired(a), new Set(['other']));
  assert.equal(p.changed, true);
  assert.deepEqual(p.map, {});
  // A corrupt file reads as empty.
  writeFileSync(join(b, 'reminders-fired.json'), '{nope');
  assert.deepEqual(readFired(b), {});
});
