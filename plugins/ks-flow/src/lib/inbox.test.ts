// Tests for lib/inbox.ts — the fold, question states, thread summaries, the
// card join and the file reader. Records are synthetic, shaped like plannotator
// 0.28.x writes them (packages/core/inbox-types.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachInbox,
  InboxFold,
  InboxReader,
  parseInboxLine,
  plannotatorDataDir,
  readInboxRegistry,
  summarizeThreads,
  type InboxLine,
} from './inbox.js';
import type { WorkUnitDoc } from './db/types.js';

const ROOT = '/repo/main';
const WT = '/repo/worktrees/kar-1';
const SESSION = 'sess-1';
let seq = 0;

function line(kind: InboxLine['kind'], record: Record<string, unknown>): InboxLine {
  return { v: 1, seq: ++seq, at: '2026-10-30T10:00:00.000Z', kind, id: record.id as string, record };
}
const project = () => line('project', { id: 'prj_1', key: 'repo-abc123', name: 'repo', root: ROOT, created_at: 'x' });
const agentMsg = (id: string, extra: Record<string, unknown> = {}) =>
  line('message', {
    id,
    project_id: 'prj_1',
    thread_id: extra.thread_id ?? id,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: SESSION, name: 'Claude Code' },
    subject: extra.thread_id ? null : 'Two questions on PR #1',
    body: 'b',
    created_at: `2026-10-30T10:00:${String(seq).padStart(2, '0')}.000Z`,
    resolved_at: null,
    idempotency_key: null,
    base_path: WT,
    wakes: true,
    ...extra,
  });
const personMsg = (id: string, thread: string, extra: Record<string, unknown> = {}) =>
  line('message', {
    id,
    project_id: 'prj_1',
    thread_id: thread,
    reply_to: thread,
    author: { kind: 'person' },
    subject: null,
    body: 'answer',
    created_at: '2026-10-30T11:00:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    ...extra,
  });
const question = (msg: string, key: string, extra: Record<string, unknown> = {}) =>
  line('question', {
    id: `${msg}/${key}`,
    project_id: 'prj_1',
    message_id: msg,
    key,
    position: 0,
    kind: 'single',
    prompt: 'Which way?',
    parsed: { context: null, choices: [], aliases: [], recommendation: null, suggested_text: null, line: 1 },
    stopped: null,
    holds_up: ['next commit on #1'],
    asked_by_agent_id: SESSION,
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    ...extra,
  });

function fold(lines: InboxLine[]): InboxFold {
  const f = new InboxFold();
  for (const l of lines) f.apply(l);
  return f;
}

const unit = (over: Partial<WorkUnitDoc> = {}): WorkUnitDoc =>
  ({
    unitId: 'KAR-1',
    type: 'ticket',
    identifier: 'KAR-1',
    title: 't',
    linearStatus: null,
    linearUrl: null,
    slackThreadUrl: null,
    priority: null,
    estimate: null,
    worktreeDir: WT,
    stateYamlPath: '/x',
    phases: [],
    currentPhase: null,
    pr: null,
    slack: null,
    waiting: null,
    sessionIds: [SESSION],
    lastActivity: null,
    state: null,
    updatedAt: 'x',
    ...over,
  }) as WorkUnitDoc;

test('parseInboxLine skips what the Inbox skips and reports unknown versions', () => {
  assert.equal(parseInboxLine(null).line, null);
  assert.equal(parseInboxLine({ v: 1, seq: 0, at: 'x', kind: 'message', id: 'a', record: { id: 'a' } }).line, null);
  assert.equal(parseInboxLine({ v: 1, seq: 1, at: 'x', kind: 'note', id: 'a', record: { id: 'a' } }).line, null);
  assert.equal(parseInboxLine({ v: 1, seq: 1, at: 'x', kind: 'message', id: 'a', record: { id: 'b' } }).line, null);
  assert.deepEqual(parseInboxLine({ v: 2, seq: 1, at: 'x', kind: 'message', id: 'a', record: { id: 'a' } }), { line: null, badVersion: 2 });
  assert.ok(parseInboxLine({ v: 1, seq: 1, at: 'x', kind: 'card', id: 'c', record: { id: 'c' } }).line);
});

test('the highest seq wins, whatever order lines arrive in', () => {
  const q1 = question('msg_a', 'q-1');
  const q2 = question('msg_a', 'q-1', { answer: { v: 1 }, revision: 1 });
  const f = fold([project(), agentMsg('msg_a'), q2, q1]);
  assert.equal(f.questionState(f.questions.get('msg_a/q-1')!), 'picked');
});

test('question states: open, picked, sent, superseded, set aside, actions', () => {
  seq = 0;
  const f = fold([
    project(),
    agentMsg('msg_a'),
    question('msg_a', 'q-open'),
    question('msg_a', 'q-picked', { answer: { v: 1 }, revision: 2, sent_revision: 1 }),
    question('msg_a', 'q-sent', { answer: { v: 1 }, revision: 1, sent_revision: 1, sent_reply_id: 'msg_r' }),
    question('msg_a', 'q-unsent', { answer: { v: 1 }, revision: 1, sent_revision: 1, sent_reply_id: 'msg_missing' }),
    question('msg_a', 'q-replaced', { superseded_by: { message_id: 'msg_b', key: null } }),
    question('msg_a', 'q-aside', { set_aside: { at: 'x' } }),
    question('msg_a', 'a-open', { kind: 'action' }),
    question('msg_a', 'a-agent', { kind: 'action', action_result: { outcome: 'done', by: 'agent' } }),
    question('msg_a', 'a-undo', { kind: 'action', action_result: { outcome: 'done', by: 'person' }, revision: 1 }),
    personMsg('msg_r', 'msg_a'),
  ]);
  const st = (k: string) => f.questionState(f.questions.get(`msg_a/${k}`)!);
  assert.equal(st('q-open'), 'open');
  assert.equal(st('q-picked'), 'picked');
  assert.equal(st('q-sent'), 'sent');
  assert.equal(st('q-unsent'), 'picked'); // its reply line never landed
  assert.equal(st('q-replaced'), 'superseded');
  assert.equal(st('q-aside'), 'closed');
  assert.equal(st('a-open'), 'open');
  assert.equal(st('a-agent'), 'closed');
  assert.equal(st('a-undo'), 'picked');

  const [t] = summarizeThreads(f, 'repo-abc123');
  // open: q-open, a-open; picked: q-picked, q-unsent (a picked action item doesn't wait)
  assert.equal(t!.open, 2);
  assert.equal(t!.picked, 2);
  assert.equal(t!.actions, 1);
  assert.deepEqual(t!.holdsUp, ['next commit on #1']);
  assert.equal(t!.linkMessageId, 'msg_a');
});

test('archiving closes the questions asked before it; a later agent message brings its own back', () => {
  seq = 0;
  const root = agentMsg('msg_a');
  const lines = [project(), root, question('msg_a', 'q-1')];
  const archived = line('message', { ...root.record, resolved_at: '2026-10-30T12:00:00.000Z' });
  const f = fold([...lines, archived]);
  assert.equal(f.questionState(f.questions.get('msg_a/q-1')!), 'closed');
  assert.equal(summarizeThreads(f, 'k').length, 0);

  const later = agentMsg('msg_b', { thread_id: 'msg_a' });
  f.apply(later);
  f.apply(question('msg_b', 'q-2'));
  assert.equal(f.questionState(f.questions.get('msg_b/q-2')!), 'open');
  const [t] = summarizeThreads(f, 'k');
  assert.equal(t!.open, 1);
  assert.equal(t!.linkMessageId, 'msg_b');

  // Unarchive: the root's resolved_at back to null reopens the first question.
  f.apply(line('message', { ...root.record, resolved_at: null }));
  assert.equal(f.questionState(f.questions.get('msg_a/q-1')!), 'open');
});

test('unseen counts agent messages past the seen mark and the last real reply, not notes', () => {
  seq = 0;
  const root = agentMsg('msg_a');
  const f = fold([project(), root]);
  assert.equal(summarizeThreads(f, 'k')[0]!.unseen, 1);
  f.apply(line('message', { ...root.record, person_seen_seq: seq }));
  assert.equal(summarizeThreads(f, 'k').length, 0); // seen, nothing waits
  f.apply(agentMsg('msg_b', { thread_id: 'msg_a' }));
  assert.equal(summarizeThreads(f, 'k')[0]!.unseen, 1);
  f.apply(personMsg('msg_note', 'msg_a', { ack_of: 'msg_b' })); // a note: still unseen
  assert.equal(summarizeThreads(f, 'k')[0]!.unseen, 1);
  f.apply(personMsg('msg_r', 'msg_a'));
  assert.equal(summarizeThreads(f, 'k').length, 0);
});

test('a card gets its threads by session id only, and waits on the Inbox', () => {
  seq = 0;
  const f = fold([project(), agentMsg('msg_a'), question('msg_a', 'q-1', { stopped: 'needs the schema' })]);
  const threads = summarizeThreads(f, 'k');

  const card = attachInbox(unit(), threads);
  assert.equal(card.inbox?.needsYou, true);
  assert.equal(card.inbox?.stopped, true);
  assert.equal(card.waiting?.tool, 'Inbox');
  assert.equal(card.waiting?.sessionId, SESSION);
  assert.equal(card.inbox?.threads[0]!.stopped, 'needs the schema');
  assert.equal('sessions' in card.inbox!.threads[0]!, false);

  // base_path is not an identity: a session the card doesn't own gets nothing,
  // even when it sent from (or named) the card's worktree.
  const byPath = attachInbox(unit({ sessionIds: [] }), threads);
  assert.equal(byPath.inbox, undefined);
  assert.equal(byPath.waiting, null);

  // Another card: nothing.
  const other = attachInbox(unit({ sessionIds: ['x'], worktreeDir: '/repo/worktrees/kar-2' }), threads);
  assert.equal(other.inbox, undefined);

  // An older wait (AskUserQuestion) stays the card's wait.
  const older = { active: true, tool: 'AskUserQuestion', since: '2026-01-01T00:00:00.000Z', sessionId: SESSION };
  assert.equal(attachInbox(unit({ waiting: older }), threads).waiting?.tool, 'AskUserQuestion');
});

test("another session replying into the card's thread doesn't put its question on the card", () => {
  seq = 0;
  const f = fold([
    project(),
    agentMsg('msg_a'), // the card's session starts the thread
    agentMsg('msg_x', {
      thread_id: 'msg_a',
      reply_to: 'msg_a',
      author: { kind: 'agent', host: 'claude-code', session: 'intruder', name: 'Claude Code' },
    }),
    question('msg_x', 'q-x', { asked_by_agent_id: 'intruder', stopped: 'fake' }),
  ]);
  const card = attachInbox(unit(), summarizeThreads(f, 'k'));
  // The card's own unseen root still shows; the intruder's question and message don't.
  assert.equal(card.inbox?.needsYou, false);
  assert.equal(card.inbox?.stopped, false);
  assert.equal(card.inbox?.threads[0]!.unseen, 1);
  assert.equal(card.inbox?.threads[0]!.questions.length, 0);
  assert.equal(card.waiting, null);
  // The intruder's own card would show it.
  const theirs = attachInbox(unit({ unitId: 'KAR-2', sessionIds: ['intruder'] }), summarizeThreads(f, 'k'));
  assert.equal(theirs.inbox?.stopped, true);
  assert.equal(theirs.waiting?.sessionId, 'intruder');
});

test('only unseen messages: listed, but the card does not need the person', () => {
  seq = 0;
  const f = fold([project(), agentMsg('msg_a')]);
  const card = attachInbox(unit(), summarizeThreads(f, 'k'));
  assert.equal(card.inbox?.needsYou, false);
  assert.equal(card.inbox?.threads[0]!.unseen, 1);
  assert.equal(card.waiting, null);
});

test('plannotatorDataDir follows the Inbox: override, ~/.plannotator, XDG', () => {
  assert.equal(plannotatorDataDir({ PLANNOTATOR_DATA_DIR: '~/x' }, '/h'), '/h/x');
  assert.equal(plannotatorDataDir({ PLANNOTATOR_DATA_DIR: '/abs' }, '/h'), '/abs');
  assert.equal(plannotatorDataDir({ XDG_DATA_HOME: '/xdg' }, '/nonexistent-home'), '/xdg/plannotator');
  assert.equal(plannotatorDataDir({ XDG_DATA_HOME: 'rel' }, '/nonexistent-home'), '/nonexistent-home/.plannotator');
});

test('the reader tails, skips torn lines, rebuilds on rewrite, drops deleted projects and other repos', () => {
  seq = 0;
  const data = mkdtempSync(join(tmpdir(), 'ks-flow-inbox-'));
  try {
    const dir = join(data, 'inbox', 'projects', 'repo-abc123');
    mkdirSync(dir, { recursive: true });
    const write = (f: string, ls: unknown[]) => appendFileSync(join(dir, f), ls.map((l) => JSON.stringify(l) + '\n').join(''));
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project()) + '\n');
    write('messages.jsonl', [agentMsg('msg_a')]);
    write('questions.jsonl', [question('msg_a', 'q-1')]);
    // A torn line (crash mid-write): not read until it ends in a newline.
    appendFileSync(join(dir, 'questions.jsonl'), '{"v":1,"seq":99,"at":"x","ki');

    const warnings: string[] = [];
    const reader = new InboxReader(data, new Set([ROOT]), (m) => warnings.push(m));
    assert.equal(reader.poll(), true);
    assert.equal(reader.threads()[0]!.open, 1);
    assert.equal(reader.poll(), false); // nothing new

    // The Inbox closes the torn line with "\n" before its next append.
    appendFileSync(join(dir, 'questions.jsonl'), '\n');
    write('questions.jsonl', [question('msg_a', 'q-1', { answer: { v: 1 }, revision: 1 })]);
    assert.equal(reader.poll(), true);
    assert.equal(reader.threads()[0]!.picked, 1);

    // A version this reader doesn't know: skipped, said once.
    write('messages.jsonl', [{ ...agentMsg('msg_z'), v: 2 }, { ...agentMsg('msg_y'), v: 2 }]);
    reader.poll();
    assert.equal(warnings.filter((w) => w.includes('version 2')).length, 1);

    // Deleting the thread rewrites the files (new inode, shorter): rebuilt from scratch.
    const tmp = join(dir, 'questions.jsonl.tmp');
    writeFileSync(tmp, '');
    renameSync(tmp, join(dir, 'questions.jsonl'));
    const tmp2 = join(dir, 'messages.jsonl.tmp');
    writeFileSync(tmp2, '');
    renameSync(tmp2, join(dir, 'messages.jsonl'));
    assert.equal(reader.poll(), true);
    assert.equal(reader.threads().length, 0);

    // Another repository's project is never read.
    const other = join(data, 'inbox', 'projects', 'other-def456');
    mkdirSync(other);
    writeFileSync(join(other, 'project.json'), JSON.stringify(line('project', { id: 'prj_2', key: 'other-def456', name: 'other', root: '/elsewhere' })) + '\n');
    appendFileSync(join(other, 'messages.jsonl'), JSON.stringify(agentMsg('msg_o')) + '\n');
    reader.poll();
    assert.equal(reader.threads().length, 0);

    // Deleting the project removes its folder.
    write('messages.jsonl', [agentMsg('msg_b')]);
    reader.poll();
    assert.equal(reader.threads().length, 1);
    rmSync(dir, { recursive: true });
    assert.equal(reader.poll(), true);
    assert.equal(reader.threads().length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('readInboxRegistry takes the address and never the token', () => {
  const data = mkdtempSync(join(tmpdir(), 'ks-flow-inbox-'));
  try {
    mkdirSync(join(data, 'inbox'));
    const entry = { v: 1, pid: 1, port: 5000, url: 'http://localhost:5000/', version: '0.28.39', token: 'a'.repeat(64), serverSession: 's', startedAt: 'x' };
    writeFileSync(join(data, 'inbox', 'inbox.json'), JSON.stringify(entry));
    const reg = readInboxRegistry(data);
    assert.deepEqual(reg, { url: 'http://localhost:5000/', port: 5000, serverSession: 's', version: '0.28.39' });
    assert.equal(JSON.stringify(reg).includes('aaaa'), false);
    writeFileSync(join(data, 'inbox', 'inbox.json'), JSON.stringify({ ...entry, v: 2 }));
    assert.equal(readInboxRegistry(data), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
