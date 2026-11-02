// Tests for lib/master-events.ts — the master_events docs the daemon writes
// for the Activity Log, and that recording one never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBriefing } from './db/providers/memory.js';
import type { MasterEventDoc } from './db/types.js';
import {
  launchOutcome,
  masterEvent,
  recordMasterEvent,
  scheduleRequestEvent,
  supervisorEvent,
} from './master-events.js';

const NOW = new Date('2026-10-31T06:00:05.000Z');

test('masterEvent: uid + at, unset optional fields left out (Firestore refuses undefined)', () => {
  const e = masterEvent({ kind: 'start', reason: 'no session.json', by: 'daemon' }, NOW);
  assert.match(e.uid, /^[0-9a-f-]{36}$/);
  assert.equal(e.at, NOW.toISOString());
  assert.deepEqual(Object.keys(e).sort(), ['at', 'by', 'kind', 'reason', 'uid']);
  assert.notEqual(masterEvent({ kind: 'start', reason: 'x', by: 'daemon' }).uid, e.uid);
});

test('supervisorEvent: a start/restart by the daemon, no result until the command exits', () => {
  const e = supervisorEvent('restart', 'a request pending 16 min, heartbeat 7 min old', NOW);
  assert.equal(e.kind, 'restart');
  assert.equal(e.by, 'daemon');
  assert.equal(e.reason, 'a request pending 16 min, heartbeat 7 min old');
  assert.equal('result' in e, false);
});

test('scheduleRequestEvent: written → ok with the request id; already pending → dropped', () => {
  const req = { v: 1 as const, id: 'r-1', trigger: 'schedule' as const, slot: '06:00', createdAt: NOW.toISOString(), prompt: 'p' };
  const ok = scheduleRequestEvent('06:00', req, NOW);
  assert.equal(ok.kind, 'request');
  assert.equal(ok.trigger, 'schedule');
  assert.equal(ok.slot, '06:00');
  assert.equal(ok.result, 'ok');
  assert.equal(ok.detail, 'request r-1');
  const dropped = scheduleRequestEvent('12:00', null, NOW);
  assert.equal(dropped.result, 'dropped');
  assert.equal(dropped.slot, '12:00');
});

test('launchOutcome: exit 0 ok, anything else failed with how it ended', () => {
  assert.deepEqual(launchOutcome(0, null), { result: 'ok', detail: 'exited 0' });
  assert.equal(launchOutcome(1, null).result, 'failed');
  assert.match(launchOutcome(1, null).detail ?? '', /exited 1/);
  assert.match(launchOutcome(null, 'SIGTERM').detail ?? '', /killed by SIGTERM/);
});

test('recordMasterEvent: stores the doc; an update by uid replaces it (one record)', async () => {
  const store = new MemoryBriefing();
  const logs: unknown[][] = [];
  const e = supervisorEvent('start', 'no session.json', NOW);
  await recordMasterEvent(store, 'p', e, (...a) => logs.push(a));
  await recordMasterEvent(store, 'p', { ...e, ...launchOutcome(0, null) }, (...a) => logs.push(a));
  const all = await store.getMasterEvents('p');
  assert.equal(all.length, 1);
  assert.equal(all[0]!.result, 'ok');
  assert.equal(logs.length, 0);
});

test('recordMasterEvent: a failing store is logged, never thrown', async () => {
  const logs: unknown[][] = [];
  const failing = {
    upsertMasterEvent: async (_p: string, _d: MasterEventDoc): Promise<void> => {
      throw new Error('pocketbase down');
    },
  };
  await recordMasterEvent(failing, 'p', supervisorEvent('start', 'x', NOW), (...a) => logs.push(a));
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]![1]), /pocketbase down/);
});

test('MemoryBriefing.getMasterEvents: newest first, limited', async () => {
  const store = new MemoryBriefing();
  for (let i = 0; i < 5; i++) {
    await store.upsertMasterEvent('p', masterEvent({ kind: 'request', reason: `r${i}`, by: 'board' }, new Date(NOW.getTime() + i * 1000)));
  }
  const two = await store.getMasterEvents('p', 2);
  assert.deepEqual(two.map((e) => e.reason), ['r4', 'r3']);
});
