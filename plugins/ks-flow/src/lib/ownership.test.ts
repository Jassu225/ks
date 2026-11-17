// Tests for lib/ownership.ts (no takeover) and lib/card-owner.ts (card-owner /
// card-move), against the in-memory DocDb fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import { CardOwners } from './ownership.js';
import { cardOwner, moveCard, startDecision } from './card-owner.js';
import { isLiveCard, deviceMap } from './liveunits.js';
import type { DeviceDoc, WorkUnitDoc } from './db/types.js';

const A = { deviceId: 'dev-a', defaultName: 'Laptop A' };
const B = { deviceId: 'dev-b', defaultName: 'Laptop B' };

function lookupFrom(db: MemoryDocDb) {
  const store = docDeviceStore(db);
  return async (unitId: string) => {
    const c = await store.getWorkUnit(unitId);
    return { exists: !!c, deviceId: c?.deviceId ?? null };
  };
}

test('ownership: a card another device owns is never written; own and new cards are', async () => {
  const db = new MemoryDocDb({
    'workUnits/KAR-1': { unitId: 'KAR-1', deviceId: 'dev-b' },
    'workUnits/KAR-2': { unitId: 'KAR-2', deviceId: 'dev-a' },
    'workUnits/KAR-3': { unitId: 'KAR-3' },
  });
  const logs: string[] = [];
  const owners = new CardOwners('dev-a', lookupFrom(db), (m) => logs.push(m));
  assert.deepEqual(await owners.decide('KAR-1'), { write: false, owner: 'dev-b' });
  assert.deepEqual(await owners.decide('KAR-2'), { write: true, owner: null });
  assert.deepEqual(await owners.decide('KAR-3'), { write: true, owner: null }, 'no owner yet: written (and stamped)');
  assert.deepEqual(await owners.decide('KAR-4'), { write: true, owner: null }, 'a new card');
  await owners.decide('KAR-1');
  assert.equal(logs.filter((l) => l.includes('KAR-1')).length, 1, 'skipping is logged once per card');
  owners.wrote('KAR-3');
  assert.equal(owners.known('KAR-3'), 'dev-a');
});

test('ownership: seeded owners need no read; a moved card follows set()', async () => {
  let reads = 0;
  const owners = new CardOwners('dev-a', async () => {
    reads++;
    return { exists: false, deviceId: null };
  });
  owners.seed([{ unitId: 'KAR-1', deviceId: 'dev-b' }, { unitId: 'KAR-2', deviceId: 'dev-a' }, { unitId: 'KAR-3' }]);
  assert.equal((await owners.decide('KAR-1')).write, false);
  assert.equal((await owners.decide('KAR-2')).write, true);
  assert.equal((await owners.decide('KAR-3')).write, true);
  assert.equal(reads, 0);
  owners.set('KAR-1', 'dev-a'); // card-move here
  assert.equal((await owners.decide('KAR-1')).write, true);
  owners.set('KAR-2', 'dev-c'); // moved away
  assert.equal((await owners.decide('KAR-2')).write, false);
});

test('ownership: an owner the store cannot tell (offline) is not written, and asked again later', async () => {
  let fail = true;
  const owners = new CardOwners('dev-a', async () => {
    if (fail) throw new Error('UNAVAILABLE');
    return { exists: true, deviceId: 'dev-b' };
  });
  assert.equal((await owners.decide('KAR-9')).write, false);
  assert.equal(owners.known('KAR-9'), undefined);
  fail = false;
  assert.deepEqual(await owners.decide('KAR-9'), { write: false, owner: 'dev-b' });
});

test('the store listener follows the cards other devices own', async () => {
  const db = new MemoryDocDb({
    'workUnits/KAR-1': { unitId: 'KAR-1', deviceId: 'dev-b', title: 't' },
    'workUnits/KAR-2': { unitId: 'KAR-2', deviceId: 'dev-a', title: 'mine' },
    'workUnits/KAR-3': { unitId: 'KAR-3', title: 'legacy, no owner' },
  });
  const store = docDeviceStore(db);
  const seen: Array<Array<{ unitId: string; deviceId: string }>> = [];
  const stop = store.watchForeignCards!('dev-a', (list) => seen.push(list));
  await store.setWorkUnitOwner('KAR-1', 'dev-a');
  stop();
  assert.deepEqual(seen, [[{ unitId: 'KAR-1', deviceId: 'dev-b' }], []], 'moved here: it leaves the list');
  assert.equal((await store.getWorkUnit('KAR-1'))!.title, 't', 'card-move only changes the owner');
});

function twoDevices(card: Partial<WorkUnitDoc>, b: Partial<DeviceDoc> = {}): MemoryDocDb {
  return new MemoryDocDb({
    'devices/dev-a': { deviceId: 'dev-a', defaultName: 'Laptop A', worktreePaths: ['/wt/A'] },
    'devices/dev-b': { deviceId: 'dev-b', defaultName: 'Laptop B', name: 'Work Mac', worktreePaths: ['/wt/KAR-1'], lastSeenAt: 'T', ...b },
    'workUnits/KAR-1': { unitId: 'KAR-1', worktreeDir: '/wt/KAR-1', deviceId: 'dev-b', ...card },
  });
}

test('card-owner: another device that still has the worktree → refuse', async () => {
  const store = docDeviceStore(twoDevices({}));
  const info = await cardOwner(store, A, 'KAR-1');
  assert.equal(info.deviceId, 'dev-b');
  assert.equal(info.device, 'Work Mac', 'the name you gave it wins');
  assert.equal(info.ownerHasWorktree, true);
  assert.equal(info.ownerHasLiveSession, false);
  assert.equal(info.ownerLastSeenAt, 'T');
  assert.equal(info.local, false);
  assert.deepEqual(startDecision(info), { action: 'refuse', message: 'KAR-1 is on Work Mac: remove it there first' });
  const res = await moveCard(store, A, 'KAR-1');
  assert.equal(res.moved, false);
  assert.equal((await store.getWorkUnit('KAR-1'))!.deviceId, 'dev-b');
});

test('card-owner: a live session on the owner also refuses (worktree gone or not)', async () => {
  const store = docDeviceStore(
    twoDevices({ worktreeDir: null, liveSessions: [{ pid: 1, sessionId: 's', cwd: '/x', procStart: 'p', startedAt: 't', tmuxPane: null, name: null }] }),
  );
  const info = await cardOwner(store, A, 'kar-1');
  assert.equal(info.unitId, 'KAR-1', 'found under its stored (upper-case) id');
  assert.equal(info.ownerHasWorktree, false);
  assert.equal(info.ownerHasLiveSession, true);
  assert.equal(startDecision(info).action, 'refuse');
});

test('card-move: the owner no longer has the worktree → moved here, with the message', async () => {
  const store = docDeviceStore(twoDevices({}, { worktreePaths: [] }));
  const res = await moveCard(store, A, 'KAR-1');
  assert.equal(res.moved, true);
  assert.equal(res.message, 'moving KAR-1 from Work Mac to Laptop A');
  assert.equal((await store.getWorkUnit('KAR-1'))!.deviceId, 'dev-a');
  // now it is this device's: nothing more to do
  assert.equal(startDecision(await cardOwner(store, A, 'KAR-1')).action, 'none');
  // and from B's side it is on A, which lists no such worktree → B may move it back
  assert.equal(startDecision(await cardOwner(store, B, 'KAR-1')).action, 'move');
});

test('card-move: a forgotten owner counts as gone; a card with no owner or none at all is left alone', async () => {
  const store = docDeviceStore(twoDevices({}, { forgotten: true }));
  const info = await cardOwner(store, A, 'KAR-1');
  assert.equal(info.ownerForgotten, true);
  assert.equal(startDecision(info).action, 'move');

  const db = new MemoryDocDb({ 'workUnits/KAR-5': { unitId: 'KAR-5' } });
  const s2 = docDeviceStore(db);
  assert.equal(startDecision(await cardOwner(s2, A, 'KAR-5')).action, 'none');
  assert.equal(startDecision(await cardOwner(s2, A, 'KAR-6')).action, 'none');
  assert.equal((await moveCard(s2, A, 'KAR-5')).moved, false);
  assert.equal(db.batches.length, 0);
});

test('isLiveCard: per owner, any number of devices; forgotten and unknown owners are not live', () => {
  const devices = deviceMap([
    { deviceId: 'a', worktreePaths: ['/wt/1'] },
    { deviceId: 'b', worktreePaths: ['/wt/1', '/wt/2'] },
    { deviceId: 'c', worktreePaths: ['/wt/3'], forgotten: true },
  ] as DeviceDoc[]);
  assert.equal(isLiveCard({ deviceId: 'a', worktreeDir: '/wt/1' }, devices), true);
  assert.equal(isLiveCard({ deviceId: 'a', worktreeDir: '/wt/2' }, devices), false, 'the same path on another device does not count');
  assert.equal(isLiveCard({ deviceId: 'b', worktreeDir: '/wt/2' }, devices), true);
  assert.equal(isLiveCard({ deviceId: 'c', worktreeDir: '/wt/3' }, devices), false);
  assert.equal(isLiveCard({ deviceId: 'z', worktreeDir: '/wt/1' }, devices), false);
  assert.equal(isLiveCard({ deviceId: 'a', worktreeDir: null }, devices), false);
  assert.equal(isLiveCard({ worktreeDir: '/wt/9' }, devices, new Set(['/wt/9'])), true, 'no owner yet: the legacy worktrees');
  assert.equal(isLiveCard({ worktreeDir: '/wt/9' }, devices), false);
});
