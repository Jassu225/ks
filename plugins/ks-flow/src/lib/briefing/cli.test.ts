// Tests for lib/briefing/keys.ts and lib/briefing/cli.ts against the memory
// store: uids and group keys, find, the add rules (derive, never touch archived,
// respect dueSetByYou, record dueHistory, linkedTo), evidence, runs and the
// daily log. Times are built from local parts, so any timezone passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBriefing } from '../db/providers/memory.js';
import type { BriefingItemDoc, ProjectDoc, SlackRef, WorkUnitDoc } from '../db/types.js';
import type { BriefingSettings } from '../boardsettings.js';
import {
  add,
  boardSummary,
  context,
  dailyGet,
  dailySet,
  evidence,
  find,
  InputError,
  localDate,
  NotFoundError,
  parseInput,
  runFinish,
  runStart,
  type BriefingEnv,
} from './cli.js';
import { groupKeyOf, inThread, itemUid, keyOf, parseSlackUrl } from './keys.js';

const P = 'proj';
const MON = new Date(2026, 9, 26, 10); // Monday 10:00 local
const SETTINGS: BriefingSettings = {
  enabled: true,
  schedule: ['00:00', '06:00', '12:00', '18:00'],
  names: ['Jaswanth'],
  halfTime: ['UBOSS'],
  slackUserId: 'UME',
};

function env(now = MON): BriefingEnv & { store: MemoryBriefing; clock: { now: Date } } {
  const clock = { now };
  return { store: new MemoryBriefing(), projectId: P, settings: SETTINGS, now: () => clock.now, clock };
}

const URL_BASE = 'https://acme.slack.com/archives/C123';
function src(ts: string, threadTs: string | null = null, from = 'UANA', sentAt = MON): SlackRef {
  const p = (t: string) => `p${t.replace('.', '')}`;
  return {
    channel: 'C123',
    channelName: '#ai',
    ts,
    threadTs,
    messageUrl: `${URL_BASE}/${p(ts)}${threadTs ? `?thread_ts=${threadTs}&cid=C123` : ''}`,
    threadUrl: threadTs ? `${URL_BASE}/${p(threadTs)}` : null,
    from: { id: from, name: 'Ana' },
    text: 'can you look at this?',
    sentAt: sentAt.toISOString(),
  };
}
const raw = (source: SlackRef, extra: Record<string, unknown> = {}) => ({
  kind: 'ask',
  title: 'Look at the report',
  why: 'Ana asked in #ai',
  source,
  dueRule: 'mention',
  ...extra,
});

test('itemUid, keyOf, groupKeyOf', () => {
  assert.equal(itemUid('slack:C123:1730392.45'), 'slack_C123_1730392_45');
  const reply = src('1761472900.000200', '1761472800.000100');
  assert.equal(keyOf(reply), 'slack:C123:1761472900.000200');
  assert.equal(groupKeyOf(reply), 'slack:C123:1761472800.000100');
  assert.equal(groupKeyOf(src('1761472800.000100')), 'slack:C123:1761472800.000100');
});

test('parseSlackUrl and inThread: message link, thread link or ts', () => {
  const reply = src('1761472900.000200', '1761472800.000100');
  assert.deepEqual(parseSlackUrl(reply.messageUrl), { channel: 'C123', ts: '1761472900.000200', threadTs: '1761472800.000100' });
  assert.deepEqual(parseSlackUrl(reply.threadUrl!), { channel: 'C123', ts: '1761472800.000100', threadTs: null });
  assert.equal(parseSlackUrl('not a url'), null);
  const g = groupKeyOf(reply);
  assert.ok(inThread(reply, g, reply.threadUrl!));
  assert.ok(inThread(reply, g, reply.messageUrl));
  assert.ok(inThread(reply, g, '1761472800.000100'));
  // another reply's link in the same thread finds it too
  assert.ok(inThread(reply, g, `${URL_BASE}/p1761473000000300?thread_ts=1761472800.000100&cid=C123`));
  assert.ok(!inThread(reply, g, `${URL_BASE}/p1761479999000000`));
});

test('parseInput rejects derived fields and bad shapes', () => {
  assert.throws(() => parseInput(raw(src('1.1'), { uid: 'x' })), InputError);
  assert.throws(() => parseInput(raw(src('1.1'), { status: 'open' })), InputError);
  assert.throws(() => parseInput(raw(src('1.1'), { kind: 'todo' })), InputError);
  assert.throws(() => parseInput(raw(src('1.1'), { dueAt: 'soon' })), InputError);
  assert.throws(() => parseInput(raw(src('1.1'), { key: 'slack:C9:1.1' })), InputError);
  assert.throws(() => parseInput({ ...raw(src('1.1')), source: { channel: 'C1' } }), InputError);
  // times are normalised to UTC Z
  const it = parseInput(raw(src('1.1'), { dueAt: '2026-10-27T10:00:00+05:30' }));
  assert.equal(it.dueAt, '2026-10-27T04:30:00.000Z');
});

test('add: derives uid, groupKey, clockStart/dueAt and the first dueHistory entry', async () => {
  const e = env();
  const [r] = await add(e, [parseInput(raw(src('1761472800.000100')))]);
  assert.deepEqual(r, {
    uid: 'slack_C123_1761472800_000100',
    key: 'slack:C123:1761472800.000100',
    action: 'created',
    dueAt: new Date(2026, 9, 27, 10).toISOString(),
  });
  const doc = (await e.store.getBriefingItem(P, r.uid))!;
  assert.equal(doc.groupKey, 'slack:C123:1761472800.000100');
  assert.equal(doc.status, 'open');
  assert.equal(doc.clockStart, MON.toISOString());
  assert.equal(doc.receivedAt, MON.toISOString());
  assert.equal(doc.fyiCap, false);
  assert.equal(doc.pushedCount, 0);
  assert.deepEqual(doc.dueHistory, [{ at: MON.toISOString(), from: null, to: doc.dueAt, by: 'master' }]);
  assert.equal(doc.linkedTo, null);
  assert.equal(doc.createdBy, 'master');
});

test('add: fyi caps, halfTime senders, weekend clock, message needs dueAt', async () => {
  const e = env();
  const sat = new Date(2026, 9, 31, 15);
  const [fyi, boss, weekend] = await add(e, [
    parseInput(raw(src('1.000001'), { kind: 'fyi', dueRule: 'fyi' })),
    parseInput(raw(src('2.000002', null, 'UBOSS'), { dueRule: 'dm' })),
    parseInput(raw(src('3.000003', null, 'UANA', sat), { dueRule: 'dm' })),
  ]);
  assert.equal((await e.store.getBriefingItem(P, fyi.uid))!.fyiCap, true);
  assert.equal('dueAt' in boss && boss.dueAt, new Date(2026, 9, 26, 12).toISOString()); // 4h halved
  const w = (await e.store.getBriefingItem(P, weekend.uid))!;
  assert.equal(w.clockStart, new Date(2026, 10, 2, 9).toISOString());
  assert.equal(w.dueAt, new Date(2026, 10, 2, 13).toISOString());
  await assert.rejects(add(e, [parseInput(raw(src('4.000004'), { dueRule: 'message' }))]), InputError);
});

test('add: a promise said as eod / tomorrow / a time', async () => {
  const e = env();
  const [eod, tom, said] = await add(e, [
    parseInput(raw(src('1.000001'), { kind: 'promise', dueRule: 'promise', promise: 'eod' })),
    parseInput(raw(src('2.000002'), { kind: 'promise', dueRule: 'promise', promise: 'tomorrow' })),
    parseInput(raw(src('3.000003'), { kind: 'promise', dueRule: 'promise', promise: new Date(2026, 9, 28, 15).toISOString() })),
  ]);
  assert.equal('dueAt' in eod && eod.dueAt, new Date(2026, 9, 26, 19).toISOString());
  assert.equal('dueAt' in tom && tom.dueAt, new Date(2026, 9, 27, 12).toISOString());
  assert.equal('dueAt' in said && said.dueAt, new Date(2026, 9, 28, 15).toISOString());
});

test('add on an existing key: updates the text fields, merges links/evidence, records a master due change', async () => {
  const e = env();
  const s = src('1761472800.000100');
  await add(e, [parseInput(raw(s, { links: [{ label: 'PR', url: 'https://gh/pr/1' }] }))]);
  e.clock.now = new Date(2026, 9, 26, 11);
  const later = new Date(2026, 9, 28, 9).toISOString();
  const [r] = await add(e, [
    parseInput(
      raw(s, {
        title: 'Review the report',
        quick: true,
        unit: 'KAR-1',
        dueAt: later,
        dueReason: 'Ana said Wednesday',
        links: [{ label: 'PR #1', url: 'https://gh/pr/1' }, { label: 'Doc', url: 'https://doc' }],
        evidence: [{ at: MON.toISOString(), text: 'PR merged' }],
      }),
    ),
  ]);
  assert.deepEqual(r, { uid: itemUid(keyOf(s)), key: keyOf(s), action: 'updated', dueAt: later, dueChanged: true });
  const doc = (await e.store.getBriefingItem(P, itemUid(keyOf(s))))!;
  assert.equal(doc.title, 'Review the report');
  assert.equal(doc.quick, true);
  assert.equal(doc.unit, 'KAR-1');
  assert.deepEqual(doc.links, [{ label: 'PR #1', url: 'https://gh/pr/1' }, { label: 'Doc', url: 'https://doc' }]);
  assert.equal(doc.evidence.length, 1);
  assert.equal(doc.dueHistory.length, 2);
  assert.deepEqual(doc.dueHistory[1], {
    at: new Date(2026, 9, 26, 11).toISOString(),
    from: new Date(2026, 9, 27, 10).toISOString(),
    to: later,
    by: 'master',
    reason: 'Ana said Wednesday',
  });
  assert.equal(doc.createdAt, MON.toISOString());
  // the same input again changes nothing
  const [again] = await add(e, [parseInput(raw(s, { title: 'Review the report', quick: true, unit: 'KAR-1', dueAt: later, evidence: [{ at: MON.toISOString(), text: 'PR merged' }] }))]);
  assert.equal('action' in again && again.action, 'unchanged');
  assert.equal((await e.store.getBriefingItem(P, itemUid(keyOf(s))))!.evidence.length, 1);
});

/** A memory store where the person archives `uid` on the board right after
 * the CLI's first read of it — the race the re-read before each write guards. */
class ArchivesAfterFirstRead extends MemoryBriefing {
  armed: string | null = null;
  override async getBriefingItem(projectId: string, uid: string): Promise<BriefingItemDoc | null> {
    const doc = await super.getBriefingItem(projectId, uid);
    if (doc && uid === this.armed) {
      this.armed = null;
      await this.upsertBriefingItem(projectId, { ...doc, status: 'archived', archivedAt: MON.toISOString(), resolution: 'done' });
    }
    return doc;
  }
}

test('add and evidence: an item archived while they run is skipped, never re-opened', async () => {
  const store = new ArchivesAfterFirstRead();
  const e = { ...env(), store };
  const s = src('1761472800.000100');
  const [r] = await add(e, [parseInput(raw(s))]);

  store.armed = r.uid;
  const [upd] = await add(e, [parseInput(raw(s, { title: 'changed' }))]);
  assert.deepEqual(upd, { uid: r.uid, key: r.key, skipped: 'archived' });
  const after = (await store.getBriefingItem(P, r.uid))!;
  assert.equal(after.status, 'archived');
  assert.equal(after.title, 'Look at the report');

  await store.upsertBriefingItem(P, { ...after, status: 'open', archivedAt: null, resolution: null });
  store.armed = r.uid;
  assert.deepEqual(await evidence(e, r.uid, 'PR merged'), { uid: r.uid, skipped: 'archived' });
  const ev = (await store.getBriefingItem(P, r.uid))!;
  assert.equal(ev.status, 'archived');
  assert.deepEqual(ev.evidence, []);
});

test('add: a due time the person set is never moved by the master', async () => {
  const e = env();
  const s = src('1761472800.000100');
  const [r] = await add(e, [parseInput(raw(s))]);
  const doc = (await e.store.getBriefingItem(P, r.uid))!;
  const mine = new Date(2026, 9, 30, 9).toISOString();
  await e.store.upsertBriefingItem(P, {
    ...doc,
    dueAt: mine,
    dueSetByYou: true,
    dueHistory: [...doc.dueHistory, { at: MON.toISOString(), from: doc.dueAt, to: mine, by: 'you' }],
  });
  const [again] = await add(e, [parseInput(raw(s, { dueAt: new Date(2026, 9, 26, 12).toISOString(), title: 'New title' }))]);
  assert.equal('dueKept' in again && again.dueKept, true);
  const after = (await e.store.getBriefingItem(P, r.uid))!;
  assert.equal(after.dueAt, mine);
  assert.equal(after.dueHistory.length, 2);
  assert.equal(after.title, 'New title');
});

test('add: never touches an archived item; a new message on an archived thread links to it', async () => {
  const e = env();
  const root = src('1761472800.000100');
  const [r] = await add(e, [parseInput(raw(root))]);
  const doc = (await e.store.getBriefingItem(P, r.uid))!;
  const archived: BriefingItemDoc = { ...doc, status: 'archived', archivedAt: MON.toISOString(), resolution: 'done', archiveNote: null };
  await e.store.upsertBriefingItem(P, archived);

  const [skip] = await add(e, [parseInput(raw(root, { title: 'changed' }))]);
  assert.deepEqual(skip, { uid: r.uid, key: r.key, skipped: 'archived' });
  assert.deepEqual(await e.store.getBriefingItem(P, r.uid), archived);

  const [follow] = await add(e, [parseInput(raw(src('1761472900.000200', '1761472800.000100')))]);
  const f = (await e.store.getBriefingItem(P, follow.uid))!;
  assert.equal(f.groupKey, doc.groupKey);
  assert.equal(f.linkedTo, r.uid);

  // with an open item in the thread, the next one is just another item of the group
  const [third] = await add(e, [parseInput(raw(src('1761473000.000300', '1761472800.000100')))]);
  assert.equal((await e.store.getBriefingItem(P, third.uid))!.linkedTo, null);
});

test('find by group, thread link, ts and key — open and archived', async () => {
  const e = env();
  const rootS = src('1761472800.000100');
  const replyS = src('1761472900.000200', '1761472800.000100');
  const [root, reply] = await add(e, [parseInput(raw(rootS)), parseInput(raw(replyS))]);
  await add(e, [parseInput(raw(src('1761479999.000900')))]);
  const d = (await e.store.getBriefingItem(P, root.uid))!;
  await e.store.upsertBriefingItem(P, { ...d, status: 'archived', archivedAt: MON.toISOString() });

  const uids = (xs: BriefingItemDoc[]) => xs.map((x) => x.uid).sort();
  const both = [root.uid, reply.uid].sort();
  assert.deepEqual(uids(await find(e, { group: groupKeyOf(rootS) })), both);
  assert.deepEqual(uids(await find(e, { thread: rootS.messageUrl })), both);
  assert.deepEqual(uids(await find(e, { thread: replyS.messageUrl })), both);
  assert.deepEqual(uids(await find(e, { thread: '1761472800.000100' })), both);
  assert.deepEqual(uids(await find(e, { key: keyOf(replyS) })), [reply.uid]);
  assert.deepEqual(await find(e, { key: 'slack:C1:0.0' }), []);
});

test('evidence appends a line; archived is skipped; unknown uid is NotFound', async () => {
  const e = env();
  const [r] = await add(e, [parseInput(raw(src('1.000001')))]);
  const out = await evidence(e, r.uid, 'PR #12 merged', 'https://gh/pr/12');
  assert.deepEqual('evidence' in out && out.evidence, [{ at: MON.toISOString(), text: 'PR #12 merged', url: 'https://gh/pr/12' }]);
  const d = (await e.store.getBriefingItem(P, r.uid))!;
  await e.store.upsertBriefingItem(P, { ...d, status: 'archived' });
  assert.deepEqual(await evidence(e, r.uid, 'again'), { uid: r.uid, skipped: 'archived' });
  await assert.rejects(evidence(e, 'nope', 't'), NotFoundError);
});

test('runs: start, finish moves the cursor; failed runs do not; context reads it', async () => {
  const e = env();
  const first = await runStart(e, 'schedule', '06:00');
  assert.equal(first.status, 'running');
  assert.equal(first.previousCursor, null);
  const cursor = '2026-10-26T09:00:00.000Z';
  const done = await runFinish(e, first.uid, { cursor, added: 2, updated: 1, summary: 'ok' });
  assert.equal(done.status, 'ok');
  assert.equal(done.slackCursor, cursor);
  await assert.rejects(runFinish(e, first.uid, { cursor, added: 0, updated: 0 }), NotFoundError);

  e.clock.now = new Date(MON.getTime() + 3_600_000);
  const second = await runStart(e, 'button', null);
  assert.equal(second.previousCursor, cursor);
  await runFinish(e, second.uid, { cursor: '2026-10-26T12:00:00.000Z', added: 0, updated: 0, failed: 'slack down' });

  const ctx = await context(e, { units: [], inboxOpen: 0 });
  assert.equal(ctx.cursor, cursor);
  assert.equal(ctx.lastRun?.uid, second.uid);
  assert.equal(ctx.lastRun?.status, 'failed');
  await assert.rejects(runStart(e, 'cron', null), InputError);
  await assert.rejects(runStart(e, 'schedule', '6am'), InputError);
});

test('context: open by due, every key, archived in the last 14 days', async () => {
  const e = env();
  const [a, b, c] = await add(e, [
    parseInput(raw(src('1.000001'), { dueRule: 'mention' })),
    parseInput(raw(src('2.000002'), { dueRule: 'dm' })),
    parseInput(raw(src('3.000003'))),
  ]);
  const old = (await e.store.getBriefingItem(P, c.uid))!;
  await e.store.upsertBriefingItem(P, { ...old, status: 'archived', archivedAt: new Date(MON.getTime() - 20 * 86_400_000).toISOString() });
  const ctx = await context(e, { units: [], inboxOpen: 0 });
  assert.deepEqual(ctx.open.map((i) => i.uid), [b.uid, a.uid]);
  assert.deepEqual(ctx.knownKeys, [a.key, b.key, c.key].sort());
  assert.deepEqual(ctx.archivedRecent, []);
  assert.deepEqual(ctx.settings, { names: SETTINGS.names, halfTime: SETTINGS.halfTime, schedule: SETTINGS.schedule });
});

test('boardSummary: live worktrees and live sessions, inbox counts', () => {
  const unit = (id: string, wt: string | null, extra: Partial<WorkUnitDoc> = {}) =>
    ({
      unitId: id,
      identifier: id,
      title: `${id} title`,
      linearStatus: 'In Progress',
      worktreeDir: wt,
      currentPhase: { number: 10, name: 'Implementation' },
      pr: null,
      waiting: null,
      ...extra,
    }) as WorkUnitDoc;
  const project = { worktreePaths: ['/wt/a', '/wt/b'] } as ProjectDoc;
  const thread = { subject: 'Two questions', open: 2, picked: 1 } as NonNullable<WorkUnitDoc['inbox']>['threads'][number];
  const s = boardSummary(project, [
    unit('KAR-2', '/wt/b', {
      inbox: { needsYou: true, stopped: false, since: null, threads: [thread] },
      waiting: { active: true, tool: 'Inbox', since: 'x', sessionId: 's' },
    }),
    unit('KAR-1', '/wt/a', { pr: { number: 1, url: 'https://gh/pr/1', repo: null } }),
    unit('KAR-3', '/wt/gone'),
    unit('KAR-4', null, { liveSessions: [{ pid: 1, sessionId: 's4', cwd: '/x', procStart: 'p', startedAt: 't', tmuxPane: '%1', name: null }] }),
  ]);
  assert.deepEqual(s.units.map((u) => u.identifier), ['KAR-1', 'KAR-2', 'KAR-4']);
  assert.equal(s.inboxOpen, 2);
  assert.deepEqual(s.units[1].inbox, { needsYou: true, stopped: false, open: 2, picked: 1, subjects: ['Two questions'] });
  assert.deepEqual(s.units[1].waiting, { tool: 'Inbox', since: 'x' });
  assert.equal(s.units[0].pr, 'https://gh/pr/1');
  assert.equal(s.units[0].phase, 'Implementation');
  assert.deepEqual(s.units[2].liveSessions, [{ pid: 1, sessionId: 's4', tmuxPane: '%1', startedAt: 't' }]);
});

test('daily set log-in then log-off; get defaults to today (local)', async () => {
  const e = env();
  const sessions = [{ unit: 'KAR-1', sessionId: 's1', phase: 'Implementation', state: 'working', lastDid: 'wrote tests' }];
  const date = localDate(MON);
  assert.equal(date, '2026-10-26');
  const a = await dailySet(e, date, 'log-in', { plan: ['x'], sessions });
  assert.equal(a.logInAt, MON.toISOString());
  assert.deepEqual(a.sessions, sessions);
  e.clock.now = new Date(2026, 9, 26, 18);
  const b = await dailySet(e, date, 'log-off', { archived: 3, at: new Date(2026, 9, 26, 17, 30).toISOString() });
  assert.deepEqual(b.logIn, { plan: ['x'], sessions });
  assert.deepEqual(b.logOff, { archived: 3, at: new Date(2026, 9, 26, 17, 30).toISOString() });
  assert.equal(b.logOffAt, new Date(2026, 9, 26, 17, 30).toISOString());
  assert.deepEqual(b.sessions, sessions); // kept: the log-off report had none
  assert.deepEqual(await dailyGet(e), b);
  assert.equal(await dailyGet(e, '2026-10-25'), null);
  await assert.rejects(dailySet(e, '26/10/2026', 'log-in', {}), InputError);
  await assert.rejects(dailySet(e, date, 'lunch', {}), InputError);
  await assert.rejects(dailySet(e, date, 'log-in', { sessions: [{ unit: 'KAR-1' }] }), InputError);
});
