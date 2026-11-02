// Tests for lib/master.ts — schedule slots, the schedule and supervision
// decisions, and the request files. Dates from local parts (any timezone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTION_GAP_MS,
  decideManualStart,
  decideSchedule,
  decideSupervision,
  latestSlot,
  pendingRequests,
  readDaemonState,
  readNotices,
  schedulePrompt,
  takeStartRequest,
  writeDaemonState,
  writeNotices,
  writeRequest,
  type MasterSession,
} from './master.js';

const L = (month: number, day: number, h = 0, m = 0) => new Date(2026, month, day, h, m);
const OCT = 9;
const SCHEDULE = ['00:00', '06:00', '12:00', '18:00'];
const MIN = 60_000;

test('latestSlot: newest slot at or before now, yesterday’s when none today yet', () => {
  assert.deepEqual(latestSlot(L(OCT, 26, 7, 30), SCHEDULE), { slot: '06:00', at: L(OCT, 26, 6) });
  assert.deepEqual(latestSlot(L(OCT, 26, 6), SCHEDULE), { slot: '06:00', at: L(OCT, 26, 6) });
  assert.deepEqual(latestSlot(L(OCT, 26, 5, 59), ['06:00', '18:00']), { slot: '18:00', at: L(OCT, 25, 18) });
  assert.equal(latestSlot(L(OCT, 26, 5), []), null);
});

test('decideSchedule: writes each slot once, when on', () => {
  const base = { schedule: SCHEDULE, enabled: true };
  const d = decideSchedule({ ...base, now: L(OCT, 26, 6, 0), slotAt: L(OCT, 26, 0).toISOString() });
  assert.deepEqual(d.write, { slot: '06:00', at: L(OCT, 26, 6) });
  assert.deepEqual(d.advanceTo, L(OCT, 26, 6));
  // Same slot again: nothing.
  const again = decideSchedule({ ...base, now: L(OCT, 26, 6, 1), slotAt: L(OCT, 26, 6).toISOString() });
  assert.equal(again.write, null);
  assert.equal(again.advanceTo, null);
});

test('decideSchedule: off, or first run → marks the slot handled without writing', () => {
  const now = L(OCT, 26, 12, 3);
  const off = decideSchedule({ now, schedule: SCHEDULE, enabled: false, slotAt: L(OCT, 26, 6).toISOString() });
  assert.equal(off.write, null);
  assert.deepEqual(off.advanceTo, L(OCT, 26, 12));
  const first = decideSchedule({ now, schedule: SCHEDULE, enabled: true, slotAt: null });
  assert.equal(first.write, null);
  assert.deepEqual(first.advanceTo, L(OCT, 26, 12));
});

test('decideSchedule: a slot missed while down is written within 6 h, skipped after', () => {
  // Down from 05:00 to 09:30: the 06:00 slot is 3.5 h old → written once.
  const late = decideSchedule({ now: L(OCT, 26, 9, 30), schedule: ['06:00'], enabled: true, slotAt: L(OCT, 25, 6).toISOString() });
  assert.deepEqual(late.write?.slot, '06:00');
  // Down until 12:30: 6.5 h old → handled, not written.
  const tooLate = decideSchedule({ now: L(OCT, 26, 12, 30), schedule: ['06:00'], enabled: true, slotAt: L(OCT, 25, 6).toISOString() });
  assert.equal(tooLate.write, null);
  assert.deepEqual(tooLate.advanceTo, L(OCT, 26, 6));
});

const SESSION: MasterSession = {
  v: 1,
  sessionId: 's1',
  pid: 4242,
  tmuxPane: '%3',
  cwd: '/p',
  startedAt: L(OCT, 26, 6).toISOString(),
  handoff: null,
};

test('decideSupervision: no session.json or no live process → start', () => {
  const now = L(OCT, 26, 12).getTime();
  const base = { now, heartbeat: null, oldestRequestAt: null, lastActionAt: null };
  assert.equal(decideSupervision({ ...base, session: null, alive: false }).action, 'start');
  assert.equal(decideSupervision({ ...base, session: SESSION, alive: false }).action, 'start');
  assert.equal(decideSupervision({ ...base, session: SESSION, alive: true }).action, null);
  // Launched a minute ago, pid not filled in yet: still starting, leave it.
  const starting = { ...SESSION, pid: null, startedAt: new Date(now - 60_000).toISOString() };
  assert.equal(decideSupervision({ ...base, session: starting, alive: false }).action, null);
  // Still no pid after the grace: start.
  const stuck = { ...starting, startedAt: new Date(now - 5 * MIN).toISOString() };
  assert.equal(decideSupervision({ ...base, session: stuck, alive: false }).action, 'start');
});

test('decideSupervision: no pid but a fresh heartbeat of the same session → starting, not down', () => {
  const now = L(OCT, 26, 12).getTime();
  const base = { now, alive: false, oldestRequestAt: null, lastActionAt: null };
  // Past the 3-min startedAt grace, pid still null.
  const session = { ...SESSION, pid: null, startedAt: new Date(now - 10 * MIN).toISOString() };
  const beat = (sessionId: string, ageMs: number) => ({ sessionId, at: new Date(now - ageMs).toISOString(), busy: false });
  assert.equal(decideSupervision({ ...base, session, heartbeat: beat(session.sessionId, 30_000) }).action, null);
  // Stale (≥ 2 min), another session's beat, or no beat: down → start.
  assert.equal(decideSupervision({ ...base, session, heartbeat: beat(session.sessionId, 2 * MIN) }).action, 'start');
  assert.equal(decideSupervision({ ...base, session, heartbeat: beat('someone-else', 30_000) }).action, 'start');
  assert.equal(decideSupervision({ ...base, session, heartbeat: null }).action, 'start');
  // A recorded pid that is gone is down, fresh heartbeat or not.
  assert.equal(
    decideSupervision({ ...base, session: { ...session, pid: 4242 }, heartbeat: beat(session.sessionId, 30_000) }).action,
    'start',
  );
});

test('decideSupervision: stuck request + stale heartbeat → restart', () => {
  const now = L(OCT, 26, 12).getTime();
  const stale = { sessionId: 's1', at: new Date(now - 6 * MIN).toISOString(), busy: false };
  const fresh = { sessionId: 's1', at: new Date(now - 30_000).toISOString(), busy: true };
  const base = { now, session: SESSION, alive: true, lastActionAt: null };
  assert.equal(decideSupervision({ ...base, heartbeat: stale, oldestRequestAt: now - 16 * MIN }).action, 'restart');
  assert.equal(decideSupervision({ ...base, heartbeat: null, oldestRequestAt: now - 16 * MIN }).action, 'restart');
  // A busy master (fresh heartbeat) on a long turn is left alone.
  assert.equal(decideSupervision({ ...base, heartbeat: fresh, oldestRequestAt: now - 40 * MIN }).action, null);
  // A request only 10 min old is not stuck yet.
  assert.equal(decideSupervision({ ...base, heartbeat: stale, oldestRequestAt: now - 10 * MIN }).action, null);
});

test('decideSupervision: at most one action per 10 min', () => {
  const now = L(OCT, 26, 12).getTime();
  const base = { now, session: null, alive: false, heartbeat: null, oldestRequestAt: null };
  const held = decideSupervision({ ...base, lastActionAt: now - 5 * MIN });
  assert.equal(held.action, null);
  assert.match(held.why, /under 10 min/);
  assert.equal(decideSupervision({ ...base, lastActionAt: now - ACTION_GAP_MS }).action, 'start');
});

test('writeRequest: one pending request per trigger; files read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-master-'));
  const now = L(OCT, 26, 6);
  const req = writeRequest(dir, { trigger: 'schedule', slot: '06:00', prompt: schedulePrompt('06:00'), now });
  assert.ok(req);
  assert.equal(req.prompt, '/ks-master:briefing schedule 06:00');
  const names = readdirSync(join(dir, 'requests'));
  assert.deepEqual(names, [`${now.toISOString()}-schedule.json`]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'requests', names[0]!), 'utf8')), req);
  // A second schedule request is dropped; another trigger is not.
  assert.equal(writeRequest(dir, { trigger: 'schedule', slot: '12:00', prompt: 'x' }), null);
  assert.ok(writeRequest(dir, { trigger: 'button', slot: null, prompt: '/ks-master:briefing button' }));
  const pending = pendingRequests(dir);
  assert.deepEqual(pending.map((p) => p.trigger).sort(), ['button', 'schedule']);
  assert.equal(pending.find((p) => p.trigger === 'schedule')!.createdAt, now.getTime());
  // Dot-files (a write in progress) are ignored; a garbled file keeps its name's trigger.
  writeFileSync(join(dir, 'requests', '.half.json'), '{');
  writeFileSync(join(dir, 'requests', '2026-10-26T07:00:00.000Z-restart.json'), 'not json');
  assert.deepEqual(pendingRequests(dir).map((p) => p.trigger).sort(), ['button', 'restart', 'schedule']);
});

test('daemon state round-trips; missing file reads as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-master-'));
  assert.deepEqual(readDaemonState(dir), { v: 1, slotAt: null, lastActionAt: null, lastAction: null });
  mkdirSync(dir, { recursive: true });
  const state = { v: 1 as const, slotAt: L(OCT, 26, 6).toISOString(), lastActionAt: null, lastAction: 'start' as const };
  writeDaemonState(dir, state);
  assert.deepEqual(readDaemonState(dir), state);
});

test('notices.json round-trips; missing or malformed reads as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-master-'));
  assert.deepEqual(readNotices(dir), {});
  const items = { a: { hot: L(OCT, 26, 13).toISOString() }, b: { hot: 'h', overdue: 'o', lastNag: 'n' } };
  writeNotices(dir, items);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf8')), { v: 1, items });
  assert.deepEqual(readNotices(dir), items);
  assert.deepEqual(readdirSync(dir), ['notices.json']); // no temp file left behind
  writeFileSync(join(dir, 'notices.json'), '{"v":1,"items":{"a":{"hot":1,"overdue":"o"},"b":"x"}}');
  assert.deepEqual(readNotices(dir), { a: { overdue: 'o' } });
});

test('takeStartRequest: read once, then gone; an unreadable file still counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-master-'));
  assert.equal(takeStartRequest(dir), null);
  writeFileSync(join(dir, 'start-request.json'), '{"v":1,"at":"2026-10-31T14:30:00.000Z","by":"board"}');
  assert.deepEqual(takeStartRequest(dir), { at: '2026-10-31T14:30:00.000Z', by: 'board' });
  assert.equal(takeStartRequest(dir), null);
  writeFileSync(join(dir, 'start-request.json'), 'not json');
  assert.deepEqual(takeStartRequest(dir), { at: null, by: 'board' });
});

test('decideManualStart: starts unless a master runs or is starting; ignores the 10-minute gap', () => {
  const now = L(OCT, 31, 14, 30).getTime();
  assert.equal(decideManualStart({ now, session: null, alive: false, heartbeat: null }).start, true);
  const dead = { ...SESSION, startedAt: new Date(now - 60 * MIN).toISOString() };
  assert.equal(decideManualStart({ now, session: dead, alive: false, heartbeat: null }).start, true);
  const live = decideManualStart({ now, session: SESSION, alive: true, heartbeat: null });
  assert.deepEqual(live, { start: false, why: 'the master is already running' });
  const booting = { ...SESSION, pid: null, startedAt: new Date(now - 1 * MIN).toISOString() };
  assert.deepEqual(decideManualStart({ now, session: booting, alive: false, heartbeat: null }), {
    start: false,
    why: 'the master is still starting',
  });
});
