// Tests for lib/briefing/notices.ts — which notices are owed for briefing items,
// how the daemon's record of them (notices.json's map) is kept, and how they
// are worded. Dates are built from local parts, so the suite passes in any
// timezone (week of Mon 26 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BriefingItemDoc } from '../db/types.js';
import { armedAt, composeNotices, dueLabel, owedNotices, recordNotices, type Notified } from './notices.js';

const L = (month: number, day: number, h = 0, m = 0) => new Date(2026, month, day, h, m);
const OCT = 9;
const SCHEDULE = ['00:00', '06:00', '12:00', '18:00'];
const ON = { schedule: SCHEDULE, enabled: true };
const NONE = {};

/** An open ask whose clock runs 10:00 → 14:00 on Mon 26 Oct (hot from 13:12). */
function item(over: Partial<BriefingItemDoc> = {}): BriefingItemDoc {
  return {
    uid: 'slack_C1_1',
    key: 'slack:C1:1',
    groupKey: 'slack:C1:1',
    kind: 'ask',
    title: 'Review the PR',
    why: 'asked in a DM',
    source: {
      channel: 'D1',
      channelName: 'DM',
      ts: '1',
      threadTs: null,
      messageUrl: 'https://x/1',
      threadUrl: null,
      from: { id: 'U1', name: 'Asha' },
      text: 'can you review?',
      sentAt: L(OCT, 26, 10).toISOString(),
    },
    receivedAt: L(OCT, 26, 10).toISOString(),
    clockStart: L(OCT, 26, 10).toISOString(),
    dueAt: L(OCT, 26, 14).toISOString(),
    dueRule: 'dm',
    dueSetByYou: false,
    dueHistory: [],
    pushedCount: 0,
    fyiCap: false,
    quick: false,
    unit: null,
    links: [],
    evidence: [],
    linkedTo: null,
    status: 'open',
    archivedAt: null,
    resolution: null,
    archiveNote: null,
    createdBy: 'master',
    runId: null,
    createdAt: L(OCT, 26, 10).toISOString(),
    updatedAt: L(OCT, 26, 10).toISOString(),
    ...over,
  };
}

/** The daemon's map with one entry for the default item. */
const sentFor = (n: Notified, uid = 'slack_C1_1') => ({ [uid]: n });

test('calm and warm items owe nothing', () => {
  assert.deepEqual(owedNotices([item()], L(OCT, 26, 11), NONE, ON), []);
  assert.deepEqual(owedNotices([item()], L(OCT, 26, 12, 30), NONE, ON), []);
});

test('turning hot owes one hot notice, recorded once', () => {
  const now = L(OCT, 26, 13, 30);
  const owed = owedNotices([item()], now, NONE, ON);
  assert.equal(owed.length, 1);
  assert.equal(owed[0]!.kind, 'hot');
  assert.deepEqual(owed[0]!.patch, { hot: now.toISOString() });
  // Once recorded, the next tick owes nothing.
  const { map } = recordNotices(NONE, owed, new Set(['slack_C1_1']));
  assert.deepEqual(map, sentFor({ hot: now.toISOString() }));
  assert.deepEqual(owedNotices([item()], L(OCT, 26, 13, 31), map, ON), []);
});

test('turning overdue owes one overdue notice; first seen overdue also marks hot', () => {
  const now = L(OCT, 26, 14, 5);
  const fresh = owedNotices([item()], now, NONE, ON);
  assert.equal(fresh[0]!.kind, 'overdue');
  assert.deepEqual(fresh[0]!.patch, { overdue: now.toISOString(), hot: now.toISOString() });
  const owed = owedNotices([item()], now, sentFor({ hot: L(OCT, 26, 13, 30).toISOString() }), ON);
  assert.equal(owed[0]!.kind, 'overdue');
  assert.deepEqual(owed[0]!.patch, { overdue: now.toISOString() });
});

test('a still-overdue item is re-nagged once per schedule slot', () => {
  const overdueAt = L(OCT, 26, 14, 5).toISOString();
  const sent = sentFor({ hot: overdueAt, overdue: overdueAt });
  // Before the 18:00 slot: nothing.
  assert.deepEqual(owedNotices([item()], L(OCT, 26, 17, 59), sent, ON), []);
  // At/after 18:00: one nag.
  const now = L(OCT, 26, 18, 0);
  const owed = owedNotices([item()], now, sent, ON);
  assert.equal(owed.length, 1);
  assert.equal(owed[0]!.kind, 'nag');
  assert.deepEqual(owed[0]!.patch, { lastNag: now.toISOString() });
  // Nagged at 18:00 → nothing more until 00:00.
  const nagged = sentFor({ hot: overdueAt, overdue: overdueAt, lastNag: now.toISOString() });
  assert.deepEqual(owedNotices([item()], L(OCT, 26, 23, 59), nagged, ON), []);
  assert.equal(owedNotices([item()], L(OCT, 27, 0, 1), nagged, ON)[0]!.kind, 'nag');
  // No schedule → no nags.
  assert.deepEqual(owedNotices([item()], now, sent, { ...ON, schedule: [] }), []);
});

test('moving the due time re-arms the notices', () => {
  const sent = sentFor({ hot: L(OCT, 26, 13, 30).toISOString() });
  const moved = item({
    dueAt: L(OCT, 26, 16).toISOString(),
    dueHistory: [
      { at: L(OCT, 26, 10).toISOString(), from: null, to: L(OCT, 26, 14).toISOString(), by: 'master' },
      { at: L(OCT, 26, 13, 45).toISOString(), from: L(OCT, 26, 14).toISOString(), to: L(OCT, 26, 16).toISOString(), by: 'you' },
    ],
  });
  assert.equal(armedAt(moved), L(OCT, 26, 13, 45).getTime());
  // 15:30 is hot again in the 10:00 → 16:00 window (≥ 14:48): owed again.
  assert.equal(owedNotices([moved], L(OCT, 26, 15, 30), sent, ON)[0]?.kind, 'hot');
});

test('archived, fyi, paused and switched-off items owe nothing', () => {
  const now = L(OCT, 26, 15);
  assert.deepEqual(owedNotices([item({ status: 'archived' })], now, NONE, ON), []);
  assert.deepEqual(owedNotices([item({ kind: 'fyi', fyiCap: true })], now, NONE, ON), []);
  assert.deepEqual(owedNotices([item({ unit: 'KAR-1' })], now, NONE, { ...ON, pausedUnits: new Set(['KAR-1']) }), []);
  assert.equal(owedNotices([item({ unit: 'KAR-2' })], now, NONE, { ...ON, pausedUnits: new Set(['KAR-1']) }).length, 1);
  assert.deepEqual(owedNotices([item()], now, NONE, { ...ON, enabled: false }), []);
});

test('recordNotices: merges each patch, prunes uids no longer open, unchanged when idle', () => {
  const at = L(OCT, 26, 14, 5).toISOString();
  const sent = { a: { hot: at }, gone: { hot: at, overdue: at } };
  const owed = owedNotices([item({ uid: 'a' })], L(OCT, 26, 18), sent, ON); // overdue, hot already sent
  const { map, changed } = recordNotices(sent, owed, new Set(['a']));
  assert.equal(changed, true);
  assert.deepEqual(map, { a: { hot: at, overdue: L(OCT, 26, 18).toISOString() } });
  // Nothing owed and nothing to prune → no write.
  assert.deepEqual(recordNotices(map, [], new Set(['a'])), { map, changed: false });
  // An archived item's entry goes even when nothing is owed.
  assert.deepEqual(recordNotices(map, [], new Set()), { map: {}, changed: true });
});

test('composeNotices: one owed → that item’s own notice', () => {
  const now = L(OCT, 26, 14, 5);
  const [n] = composeNotices(owedNotices([item()], now, NONE, ON), now);
  assert.equal(n!.group, 'briefing-slack_C1_1');
  assert.equal(n!.subtitle, 'Overdue — was due 14:00');
  assert.equal(n!.message, 'Review the PR (Asha · DM)');
});

test('composeNotices: several owed (startup, a late batch) → one summary', () => {
  const now = L(OCT, 26, 14, 5);
  const items = [
    item(),
    item({ uid: 'b', title: 'Reply to Ben', dueAt: L(OCT, 26, 14, 30).toISOString() }), // hot
    item({ uid: 'c', title: 'Send the doc', dueAt: L(OCT, 26, 12).toISOString() }), // overdue
  ];
  const notices = composeNotices(owedNotices(items, now, NONE, ON), now);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.group, 'briefing-summary');
  assert.equal(notices[0]!.subtitle, '3 items need you: 2 overdue, 1 due soon');
  assert.equal(notices[0]!.message, 'Send the doc · Review the PR · Reply to Ben');
  assert.deepEqual(composeNotices([], now), []);
});

test('dueLabel: time today, weekday + time otherwise', () => {
  const now = L(OCT, 26, 9);
  assert.equal(dueLabel(L(OCT, 26, 7, 5).toISOString(), now), '07:05');
  assert.equal(dueLabel(L(OCT, 27, 12).toISOString(), now), 'Tue 12:00');
});
