// Tests for lib/sharedsettings.ts: meta/settings ↔ board-settings.json, against
// the in-memory DocDb fake and a temp data dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import type { DocDb } from './db/types.js';
import {
  pendingSettingsWrite,
  readBoardSettings,
  reconcile,
  syncSharedSettings,
  writeBoardSettings,
} from './sharedsettings.js';

const T1 = '2026-11-16T10:00:00.000Z';
const T2 = '2026-11-16T11:00:00.000Z';

function dir(file?: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'ksflow-settings-'));
  if (file) writeFileSync(join(d, 'board-settings.json'), JSON.stringify(file));
  return d;
}

test('reconcile: a newer store copy replaces the shared blocks, keeps local blocks, mirrors the master device', () => {
  const file = {
    removeCommand: 'rm-wt',
    reminders: { enabled: true },
    transcriptBackup: { hour: 1 },
    sharedUpdatedAt: T1,
  };
  const r = reconcile(file, { masterDeviceId: 'dev-a', reminders: { enabled: false }, sharedUpdatedAt: T2 }, { pendingStoreWrite: false });
  assert.deepEqual(r.file, {
    removeCommand: 'rm-wt',
    reminders: { enabled: false },
    masterDeviceId: 'dev-a',
    sharedUpdatedAt: T2,
  });
  assert.equal(r.storePatch, null);
});

test('reconcile: an older store copy never overwrites a newer local save waiting in the outbox', () => {
  const file = { briefing: { enabled: true }, sharedUpdatedAt: T2, masterDeviceId: 'dev-a' };
  const store = { masterDeviceId: 'dev-a', briefing: { enabled: false }, sharedUpdatedAt: T1 };
  const waiting = reconcile(file, store, { pendingStoreWrite: true });
  assert.equal(waiting.file, null);
  assert.equal(waiting.storePatch, null);
  assert.match(waiting.why, /outbox/);
  // Nothing waiting any more (the write was lost, or another device's older
  // save landed after ours): the newer local save is pushed.
  const heal = reconcile(file, store, { pendingStoreWrite: false });
  assert.equal(heal.file, null);
  assert.deepEqual(heal.storePatch, { briefing: { enabled: true }, sharedUpdatedAt: T2 });
});

test('reconcile: same stamp and same master is a no-op; a new master device alone still mirrors', () => {
  const file = { notes: { enabled: true }, sharedUpdatedAt: T1, masterDeviceId: 'dev-a' };
  const same = reconcile(file, { masterDeviceId: 'dev-a', notes: { enabled: true }, sharedUpdatedAt: T1 }, { pendingStoreWrite: false });
  assert.equal(same.file, null);
  assert.equal(same.storePatch, null);
  const moved = reconcile(file, { masterDeviceId: 'dev-b', notes: { enabled: true }, sharedUpdatedAt: T1 }, { pendingStoreWrite: false });
  assert.deepEqual(moved.file, { ...file, masterDeviceId: 'dev-b' });
});

test('reconcile: a device joining with an unstamped file takes the store copy', () => {
  const file = { removeCommand: 'x', gcsArchive: { enabled: false, bucket: 'old' } };
  const r = reconcile(file, { masterDeviceId: 'dev-a', gcsArchive: { enabled: true, bucket: 'b' }, sharedUpdatedAt: T1 }, { pendingStoreWrite: false });
  assert.deepEqual(r.file, { removeCommand: 'x', gcsArchive: { enabled: true, bucket: 'b' }, masterDeviceId: 'dev-a', sharedUpdatedAt: T1 });
});

test('sync: before the backfill (no meta/settings) the file is left alone', async () => {
  const d = dir({ reminders: { enabled: false } });
  const res = await syncSharedSettings({ dataDir: d, store: docDeviceStore(new MemoryDocDb()) });
  assert.equal(res.settings, null);
  assert.equal(res.wroteFile, false);
  assert.deepEqual(readBoardSettings(d), { reminders: { enabled: false } });
});

test('sync: the store copy lands in the file; a later local save is pushed back', async () => {
  const db = new MemoryDocDb({
    'meta/settings': { masterDeviceId: 'dev-a', briefing: { enabled: true, schedule: ['06:00'] }, sharedUpdatedAt: T1 },
  });
  const store = docDeviceStore(db);
  const d = dir({ removeCommand: 'keep me' });
  const first = await syncSharedSettings({ dataDir: d, store });
  assert.equal(first.wroteFile, true);
  assert.deepEqual(readBoardSettings(d), {
    removeCommand: 'keep me',
    briefing: { enabled: true, schedule: ['06:00'] },
    masterDeviceId: 'dev-a',
    sharedUpdatedAt: T1,
  });
  // A save on this device's board (file stamped T2), its store write lost.
  writeBoardSettings(d, { ...readBoardSettings(d), briefing: { enabled: false, schedule: ['06:00'] }, sharedUpdatedAt: T2 });
  const second = await syncSharedSettings({ dataDir: d, store, pendingStoreWrite: () => false });
  assert.equal(second.pushed, true);
  const now = (await db.get('meta/settings'))!;
  assert.deepEqual(now.briefing, { enabled: false, schedule: ['06:00'] });
  assert.equal(now.sharedUpdatedAt, T2);
  assert.equal(now.masterDeviceId, 'dev-a');
});

test('sync: offline (store unreadable) keeps the file and pushes nothing', async () => {
  const failing: DocDb = {
    get: async () => {
      throw new Error('UNAVAILABLE: offline');
    },
    list: async () => [],
    create: async () => false,
    write: async () => {
      throw new Error('should not write');
    },
  };
  const d = dir({ reminders: { enabled: true }, sharedUpdatedAt: T2, masterDeviceId: 'dev-a' });
  const before = readFileSync(join(d, 'board-settings.json'), 'utf8');
  const logs: string[] = [];
  const res = await syncSharedSettings({ dataDir: d, store: docDeviceStore(failing), log: (m) => logs.push(m) });
  assert.equal(res.settings, undefined);
  assert.equal(res.wroteFile, false);
  assert.equal(readFileSync(join(d, 'board-settings.json'), 'utf8'), before);
  assert.match(logs[0] ?? '', /not readable/);
});

test('sync: a listener-delivered doc is used as is; the watch fires on every change', async () => {
  const db = new MemoryDocDb({ 'meta/settings': { masterDeviceId: 'dev-a', sharedUpdatedAt: T1 } });
  const store = docDeviceStore(db);
  const seen: Array<string | undefined> = [];
  const stop = store.watchSettings!((s) => seen.push(s?.masterDeviceId));
  await store.mergeSettings({ masterDeviceId: 'dev-b' });
  stop();
  await store.mergeSettings({ masterDeviceId: 'dev-c' });
  assert.deepEqual(seen, ['dev-a', 'dev-b']);
  const d = dir({});
  await syncSharedSettings({ dataDir: d, store, known: { masterDeviceId: 'dev-z', sharedUpdatedAt: T1 } });
  assert.equal(readBoardSettings(d).masterDeviceId, 'dev-z');
});

test('pendingSettingsWrite: only a queued meta/settings write counts', () => {
  assert.equal(pendingSettingsWrite([{ entry: { path: 'workUnits/KAR-1' } }]), false);
  assert.equal(pendingSettingsWrite([{ entry: { path: 'workUnits/KAR-1' } }, { entry: { path: 'meta/settings' } }]), true);
});
