// Tests for lib/briefing/escalation.ts — stages, weekend rules, due times,
// sections and grouping — and that the board's copy hasn't drifted. Every date
// is built from local parts (L(...)), so the suite passes in any timezone; the
// week used is Mon 26 Oct – Mon 2 Nov 2026 (US clocks change on Sun 1 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clockStartFor,
  dueFor,
  groupItems,
  groupStage,
  sectionOf,
  SECTION_ORDER,
  shiftOffWeekend,
  stageOf,
  STAGE_AT,
} from './escalation.js';

/** Local time in 2026: L(month, day, hour, minute), month 0-based (9 = October). */
const L = (month: number, day: number, h = 0, m = 0) => new Date(2026, month, day, h, m);
const OCT = 9;
const NOV = 10;
const MON = L(OCT, 26, 10); // Monday 10:00
const FRI = L(OCT, 30, 10); // Friday 10:00
const SAT = L(OCT, 31, 15); // Saturday 15:00
const SUN = L(NOV, 1, 20); // Sunday 20:00

const item = (start: Date, due: Date, fyiCap = false) => ({
  clockStart: start.toISOString(),
  dueAt: due.toISOString(),
  fyiCap,
});
const at = (start: Date, hours: number) => new Date(start.getTime() + hours * 3_600_000);

test('stageOf: calm, warm at half, hot at 0.8, overdue at the due time', () => {
  const it = item(MON, at(MON, 10));
  assert.equal(stageOf(it, at(MON, 0)), 'calm');
  assert.equal(stageOf(it, at(MON, 4.99)), 'calm');
  assert.equal(stageOf(it, at(MON, 10 * STAGE_AT.warm)), 'warm');
  assert.equal(stageOf(it, at(MON, 7.99)), 'warm');
  assert.equal(stageOf(it, at(MON, 10 * STAGE_AT.hot)), 'hot');
  assert.equal(stageOf(it, at(MON, 10)), 'overdue');
  assert.equal(stageOf(it, at(MON, 50)), 'overdue');
});

test('stageOf: before the clock starts (weekend) the item is calm', () => {
  const start = clockStartFor(SAT);
  assert.equal(stageOf(item(start, at(start, 4)), SAT), 'calm');
});

test('stageOf: fyiCap never passes warm', () => {
  const it = item(MON, at(MON, 10), true);
  assert.equal(stageOf(it, at(MON, 1)), 'calm');
  assert.equal(stageOf(it, at(MON, 6)), 'warm');
  assert.equal(stageOf(it, at(MON, 9)), 'warm');
  assert.equal(stageOf(it, at(MON, 99)), 'warm');
});

test('stageOf: an empty or negative window is hot until due, then overdue', () => {
  assert.equal(stageOf(item(MON, at(MON, -2)), at(MON, -3)), 'hot');
  assert.equal(stageOf(item(MON, at(MON, -2)), MON), 'overdue');
  assert.equal(stageOf(item(MON, MON), at(MON, -1)), 'hot');
  assert.equal(stageOf(item(MON, MON), MON), 'overdue');
  assert.equal(stageOf(item(MON, MON, true), MON), 'warm');
});

test('clockStartFor: Saturday and Sunday start Monday 09:00 local; weekdays as received', () => {
  assert.deepEqual(clockStartFor(SAT), L(NOV, 2, 9));
  assert.deepEqual(clockStartFor(SUN), L(NOV, 2, 9));
  assert.deepEqual(clockStartFor(L(OCT, 31, 0, 1)), L(NOV, 2, 9));
  assert.deepEqual(clockStartFor(FRI), FRI);
  assert.deepEqual(clockStartFor(L(OCT, 30, 23, 59)), L(OCT, 30, 23, 59));
  assert.deepEqual(clockStartFor(MON), MON);
});

test('shiftOffWeekend: Sat/Sun → Monday, same local time; weekdays unchanged', () => {
  assert.deepEqual(shiftOffWeekend(L(OCT, 31, 14, 30)), L(NOV, 2, 14, 30));
  assert.deepEqual(shiftOffWeekend(L(NOV, 1, 8, 15)), L(NOV, 2, 8, 15));
  assert.deepEqual(shiftOffWeekend(FRI), FRI);
});

test('dueFor: dm +4h, mention +24h, fyi +24h from clockStart', () => {
  assert.deepEqual(dueFor({ rule: 'dm', receivedAt: MON }), { clockStart: MON, dueAt: at(MON, 4) });
  assert.deepEqual(dueFor({ rule: 'mention', receivedAt: MON }).dueAt, L(OCT, 27, 10));
  assert.deepEqual(dueFor({ rule: 'fyi', receivedAt: MON }).dueAt, L(OCT, 27, 10));
});

test('dueFor: a weekend message runs from Monday 09:00', () => {
  assert.deepEqual(dueFor({ rule: 'dm', receivedAt: SAT }), { clockStart: L(NOV, 2, 9), dueAt: L(NOV, 2, 13) });
  assert.deepEqual(dueFor({ rule: 'mention', receivedAt: SUN }).dueAt, L(NOV, 3, 9));
});

test('dueFor: a due time landing on the weekend moves to Monday, same time', () => {
  // Friday 10:00 + 24h = Saturday 10:00 → Monday 10:00.
  assert.deepEqual(dueFor({ rule: 'mention', receivedAt: FRI }).dueAt, L(NOV, 2, 10));
  // Friday 22:00 + 4h = Saturday 02:00 → Monday 02:00.
  assert.deepEqual(dueFor({ rule: 'dm', receivedAt: L(OCT, 30, 22) }).dueAt, L(NOV, 2, 2));
});

test("dueFor: a message's own deadline is used as is, never shifted", () => {
  const deadline = L(OCT, 31, 12); // a Saturday
  assert.deepEqual(dueFor({ rule: 'message', receivedAt: FRI, messageDeadline: deadline }), {
    clockStart: FRI,
    dueAt: deadline,
  });
  assert.throws(() => dueFor({ rule: 'message', receivedAt: FRI }));
});

test('dueFor: promise eod = 19:00 that working day; tomorrow = next working day 12:00', () => {
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: MON, promise: 'eod' }).dueAt, L(OCT, 26, 19));
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: MON, promise: 'tomorrow' }).dueAt, L(OCT, 27, 12));
  // Friday's "tomorrow" is Monday.
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: FRI, promise: 'tomorrow' }).dueAt, L(NOV, 2, 12));
  // Said on Saturday: the clock starts Monday, so eod is Monday 19:00, tomorrow Tuesday 12:00.
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: SAT, promise: 'eod' }).dueAt, L(NOV, 2, 19));
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: SAT, promise: 'tomorrow' }).dueAt, L(NOV, 3, 12));
});

test('dueFor: promise none = +24h (weekend-shifted); a said Date is kept as is', () => {
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: MON, promise: 'none' }).dueAt, L(OCT, 27, 10));
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: MON }).dueAt, L(OCT, 27, 10));
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: FRI, promise: 'none' }).dueAt, L(NOV, 2, 10));
  const said = L(NOV, 1, 18); // a Sunday, as said
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: FRI, promise: said }).dueAt, said);
});

test('dueFor: halfTime halves the plain windows, not fixed times', () => {
  assert.deepEqual(dueFor({ rule: 'dm', receivedAt: MON, halfTime: true }).dueAt, at(MON, 2));
  assert.deepEqual(dueFor({ rule: 'mention', receivedAt: MON, halfTime: true }).dueAt, L(OCT, 26, 22));
  assert.deepEqual(dueFor({ rule: 'fyi', receivedAt: MON, halfTime: true }).dueAt, L(OCT, 26, 22));
  assert.deepEqual(dueFor({ rule: 'promise', receivedAt: MON, promise: 'eod', halfTime: true }).dueAt, L(OCT, 26, 19));
  // Friday 18:00 + 12h = Saturday 06:00 → Monday 06:00.
  assert.deepEqual(dueFor({ rule: 'mention', receivedAt: L(OCT, 30, 18), halfTime: true }).dueAt, L(NOV, 2, 6));
});

test('sectionOf: fyi, overdue, hot, quick, today, later', () => {
  const now = L(OCT, 26, 10);
  const it = (dueAt: Date, kind: 'ask' | 'promise' | 'fyi' = 'ask', quick = false) => ({ kind, quick, dueAt: dueAt.toISOString() });
  assert.equal(sectionOf('overdue', it(L(OCT, 26, 9), 'fyi'), now), 'fyi');
  assert.equal(sectionOf('overdue', it(L(OCT, 26, 9), 'ask', true), now), 'overdue');
  assert.equal(sectionOf('hot', it(L(OCT, 26, 11), 'promise', true), now), 'hot');
  assert.equal(sectionOf('warm', it(L(OCT, 28, 11), 'ask', true), now), 'quick');
  assert.equal(sectionOf('calm', it(L(OCT, 26, 23, 59)), now), 'today');
  assert.equal(sectionOf('calm', it(L(OCT, 27, 0)), now), 'later');
  assert.deepEqual(SECTION_ORDER, ['overdue', 'hot', 'quick', 'today', 'later', 'fyi']);
});

test('groupItems: open items only, grouped by groupKey, sorted by due', () => {
  const mk = (uid: string, groupKey: string, due: Date, status = 'open') => ({ uid, groupKey, dueAt: due.toISOString(), status });
  const groups = groupItems([
    mk('a1', 'A', L(OCT, 27, 12)),
    mk('b1', 'B', L(OCT, 28, 9)),
    mk('a2', 'A', L(OCT, 27, 9)),
    mk('c1', 'C', L(OCT, 26, 9), 'archived'),
    mk('b2', 'B', L(OCT, 26, 15)),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.groupKey, g.items.map((i) => i.uid)]),
    [
      ['B', ['b2', 'b1']],
      ['A', ['a2', 'a1']],
    ],
  );
});

test('groupStage: the worst stage; calm when empty', () => {
  assert.equal(groupStage([]), 'calm');
  assert.equal(groupStage(['calm', 'warm']), 'warm');
  assert.equal(groupStage(['warm', 'overdue', 'hot']), 'overdue');
  assert.equal(groupStage(['hot', 'calm']), 'hot');
});

test("the board's copy (web/lib/briefing-escalation.ts) matches below the first line", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const body = (p: string) => readFileSync(p, 'utf8').split('\n').slice(1).join('\n');
  assert.equal(body(join(here, '../../../web/lib/briefing-escalation.ts')), body(join(here, 'escalation.ts')));
});
