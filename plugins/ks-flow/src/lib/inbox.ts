// lib/inbox.ts — read-only view of the Plannotator Inbox, for the cards.
//
// The Inbox (plannotator, third-party) keeps one append-only event log per
// project under <dataDir>/inbox/projects/<key>/: project.json, messages.jsonl,
// questions.jsonl (questions AND action items), annotations.jsonl, cards.jsonl.
// Every line is `{v, seq, at, kind, id, record}` and a FULL snapshot of the
// record: per `kind:id` the highest seq wins. seq is one counter across the
// whole Inbox. The format is the Inbox's own (packages/shared/inbox/{schema,
// store}.ts, packages/core/inbox-{types,questions}.ts in plannotator 0.28.x),
// not a published one; its rule is "fields are only ever added; readers ignore
// what they do not know and skip a line that does not parse". So: v must be 1,
// unknown kinds and fields are ignored, a line that fails to parse is skipped.
//
// Files can shrink: deleting a thread rewrites the project's files (temp file +
// rename, new inode) and deleting a project removes its folder. A crash can
// leave a torn last line, which the Inbox later closes with "\n". Reading is
// tail-by-offset per file; a new inode or a smaller file re-reads the project.
//
// Nothing here touches inbox.json's `token`: only `url`, `port` and
// `serverSession` are read, and nothing is written anywhere.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseComplete, readRange } from './jsonl.js';
import type { InboxCardState, InboxQuestionRef, InboxThreadRef, WaitingState, WorkUnitDoc } from './db/types.js';

// ── data folder ─────────────────────────────────────────────────────────────

/** The Inbox's data folder, as plannotator's getPlannotatorDataDir picks it. */
export function plannotatorDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.PLANNOTATOR_DATA_DIR?.trim();
  if (override) {
    if (override === '~') return home;
    if (override.startsWith('~/')) return join(home, override.slice(2));
    return resolve(override);
  }
  const dot = join(home, '.plannotator');
  if (existsSync(dot)) return dot;
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, 'plannotator');
  return dot;
}

// ── records (only the fields read here; everything is optional on disk) ─────

type InboxKind = 'project' | 'message' | 'question' | 'annotation' | 'card';
const KINDS = new Set<InboxKind>(['project', 'message', 'question', 'annotation', 'card']);

export interface InboxLine {
  v: number;
  seq: number;
  at: string;
  kind: InboxKind;
  id: string;
  record: Record<string, unknown>;
}

export interface InboxProject {
  id: string;
  key: string;
  name: string;
  root: string;
}

export interface InboxMessage {
  id: string;
  thread_id: string;
  reply_to: string | null;
  author: { kind: 'person' } | { kind: 'agent'; host: string | null; session: string | null; name: string | null };
  subject: string | null;
  thread_name?: string | null;
  created_at: string;
  resolved_at: string | null;
  base_path?: string | null;
  person_seen_seq?: number | null;
  /** Person-side notes (set aside, ack, re-ask, tidy, action report) are not replies. */
  set_aside?: unknown;
  reopened?: unknown;
  ack_of?: unknown;
  reask?: unknown;
  tidy?: unknown;
  action_report?: unknown;
}

export interface InboxQuestion {
  id: string;
  message_id: string;
  key: string;
  position: number;
  kind: string; // single | multi | text | action (others: read-only)
  prompt: string;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  answer: unknown | null;
  revision: number;
  sent_revision: number;
  sent_reply_id: string | null;
  superseded_by?: unknown | null;
  set_aside?: unknown | null;
  action_result?: { by?: string } | null;
}

export type QuestionState = 'superseded' | 'closed' | 'open' | 'picked' | 'sent';

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * One parsed log line, or null for a line the Inbox itself would skip (its
 * parseInboxLine), or one of a record version this reader doesn't know.
 * `badVersion` reports the latter so the caller can say so once.
 */
export function parseInboxLine(x: unknown): { line: InboxLine | null; badVersion?: number } {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { line: null };
  const o = x as Record<string, unknown>;
  if (typeof o.v !== 'number') return { line: null };
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return { line: null };
  if (typeof o.at !== 'string') return { line: null };
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind as InboxKind)) return { line: null };
  if (typeof o.id !== 'string' || o.id === '') return { line: null };
  const r = o.record;
  if (!r || typeof r !== 'object' || Array.isArray(r) || (r as { id?: unknown }).id !== o.id) return { line: null };
  if (o.v !== 1) return { line: null, badVersion: o.v };
  return { line: o as unknown as InboxLine };
}

function readMessage(r: Record<string, unknown>): InboxMessage | null {
  const id = str(r.id);
  const thread = str(r.thread_id);
  const a = r.author as Record<string, unknown> | undefined;
  if (!id || !thread || !a || (a.kind !== 'person' && a.kind !== 'agent')) return null;
  return {
    ...(r as object),
    id,
    thread_id: thread,
    reply_to: str(r.reply_to),
    author:
      a.kind === 'person'
        ? { kind: 'person' }
        : { kind: 'agent', host: str(a.host), session: str(a.session), name: str(a.name) },
    subject: str(r.subject),
    created_at: str(r.created_at) ?? '',
    resolved_at: str(r.resolved_at),
    base_path: str(r.base_path),
    person_seen_seq: typeof r.person_seen_seq === 'number' ? r.person_seen_seq : null,
  };
}

function readQuestion(r: Record<string, unknown>): InboxQuestion | null {
  const id = str(r.id);
  const message = str(r.message_id);
  if (!id || !message) return null;
  return {
    id,
    message_id: message,
    key: str(r.key) ?? id.slice(id.lastIndexOf('/') + 1),
    position: num(r.position),
    kind: str(r.kind) ?? 'unknown',
    prompt: str(r.prompt) ?? '',
    stopped: str(r.stopped),
    holds_up: Array.isArray(r.holds_up) ? r.holds_up.filter((h): h is string => typeof h === 'string') : [],
    asked_by_agent_id: str(r.asked_by_agent_id),
    answer: r.answer ?? null,
    revision: num(r.revision),
    sent_revision: num(r.sent_revision),
    sent_reply_id: str(r.sent_reply_id),
    superseded_by: r.superseded_by ?? null,
    set_aside: r.set_aside ?? null,
    action_result: (r.action_result as { by?: string } | null | undefined) ?? null,
  };
}

/** A person message that is an Inbox note (not a reply the person wrote). */
function isNote(m: InboxMessage): boolean {
  return !!(m.set_aside || m.reopened || m.ack_of || m.reask || m.tidy || m.action_report);
}

// ── fold ────────────────────────────────────────────────────────────────────

/** One project's records, folded the way the Inbox's InboxStore.apply folds them. */
export class InboxFold {
  project: InboxProject | null = null;
  private seqOf = new Map<string, number>(); // `${kind}:${id}` → winning seq
  readonly messages = new Map<string, InboxMessage>();
  readonly questions = new Map<string, InboxQuestion>();
  /** seq of a message's FIRST line: where it sits in the thread. */
  readonly messageSeq = new Map<string, number>();
  /** seq of a root's archive line (the line where resolved_at last became set). */
  private resolvedSeq = new Map<string, number>();

  apply(line: InboxLine): void {
    const key = `${line.kind}:${line.id}`;
    const prev = this.seqOf.get(key);
    if (prev !== undefined && prev > line.seq) return;
    this.seqOf.set(key, line.seq);
    switch (line.kind) {
      case 'project': {
        const r = line.record;
        const id = str(r.id), k = str(r.key), root = str(r.root);
        if (id && k && root) this.project = { id, key: k, name: str(r.name) ?? k, root };
        break;
      }
      case 'message': {
        const m = readMessage(line.record);
        if (!m) break;
        const before = this.messages.get(m.id)?.resolved_at ?? null;
        if (m.resolved_at == null) this.resolvedSeq.delete(m.id);
        else if (before !== m.resolved_at || !this.resolvedSeq.has(m.id)) this.resolvedSeq.set(m.id, line.seq);
        this.messages.set(m.id, m);
        if (!this.messageSeq.has(m.id)) this.messageSeq.set(m.id, line.seq);
        break;
      }
      case 'question': {
        const q = readQuestion(line.record);
        if (q) this.questions.set(q.id, q);
        break;
      }
      // annotations and Board cards: nothing on a ks-flow card reads them
    }
  }

  /** The seq of a resolved thread's archive line; null for an open thread. */
  archiveSeq(threadId: string): number | null {
    const root = this.messages.get(threadId);
    if (!root || root.resolved_at == null) return null;
    return this.resolvedSeq.get(root.id) ?? Number.MAX_SAFE_INTEGER;
  }

  /** The person archived the thread after this message arrived. */
  closedByArchive(m: InboxMessage): boolean {
    const a = this.archiveSeq(m.thread_id);
    return a !== null && (this.messageSeq.get(m.id) ?? 0) < a;
  }

  questionState(q: InboxQuestion): QuestionState {
    const m = this.messages.get(q.message_id);
    const archived = m ? this.closedByArchive(m) : false;
    const state = questionState(q, archived);
    // On Send the question lines (sent_reply_id) are written before the reply
    // line: until that reply exists the answer is picked, not sent.
    if (state === 'sent' && q.sent_reply_id && !this.messages.has(q.sent_reply_id)) return 'picked';
    return state;
  }
}

/** The Inbox's inboxQuestionState: derived, never stored. */
export function questionState(q: InboxQuestion, threadResolved: boolean): QuestionState {
  if (q.superseded_by) return 'superseded';
  if (q.kind === 'action' && q.action_result?.by === 'agent') return 'closed';
  if (threadResolved || q.set_aside) return 'closed';
  if (q.kind === 'action') {
    if (!q.action_result) return 'open';
    return q.revision > 0 && q.sent_revision === q.revision ? 'sent' : 'picked';
  }
  if (q.answer === null) return 'open';
  if (q.revision > 0 && q.sent_revision === q.revision) return 'sent';
  return 'picked';
}

// ── per-thread summary ──────────────────────────────────────────────────────

/** What a card needs to know about one Inbox thread, before it is narrowed to the card's sessions. */
export interface ThreadSummary extends InboxThreadRef {
  /** Agent sessions that wrote in the thread or asked its questions. */
  sessions: string[];
  /** The agent messages the person hasn't seen, oldest first, with the session that wrote each. */
  unseenMessages: Array<{ id: string; session: string | null }>;
}

const PROMPT_MAX = 240;
const clip = (s: string, n = PROMPT_MAX): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The counts a thread row shows, over the questions it keeps (oldest message first). */
function tally(questions: InboxQuestionRef[]) {
  const open = questions.filter((q) => q.state === 'open').length;
  return {
    open,
    picked: questions.length - open,
    actions: questions.filter((q) => q.kind === 'action').length,
    stopped: questions.find((q) => q.stopped)?.stopped ?? null,
    holdsUp: [...new Set(questions.flatMap((q) => q.holdsUp))],
    since: questions.reduce<string | null>((acc, q) => (!acc || q.askedAt < acc ? q.askedAt : acc), null),
    firstMessageId: questions[0]?.messageId ?? null,
  };
}

/**
 * Every thread in the fold that has something for the person: open questions
 * or action items, answers picked but not sent, or agent messages the person
 * hasn't seen. Threads with none of that are left out.
 */
export function summarizeThreads(fold: InboxFold, projectKey: string): ThreadSummary[] {
  const byThread = new Map<string, InboxMessage[]>();
  for (const m of fold.messages.values()) {
    const list = byThread.get(m.thread_id);
    if (list) list.push(m);
    else byThread.set(m.thread_id, [m]);
  }
  const questionsByMessage = new Map<string, InboxQuestion[]>();
  for (const q of fold.questions.values()) {
    const list = questionsByMessage.get(q.message_id);
    if (list) list.push(q);
    else questionsByMessage.set(q.message_id, [q]);
  }

  const out: ThreadSummary[] = [];
  for (const [threadId, members] of byThread) {
    const root = fold.messages.get(threadId);
    if (!root) continue; // a reply whose root was deleted
    const seqOf = (m: InboxMessage) => fold.messageSeq.get(m.id) ?? 0;
    members.sort((a, b) => seqOf(a) - seqOf(b));

    const sessions = new Set<string>();
    const questions: InboxQuestionRef[] = [];
    for (const m of members) {
      if (m.author.kind === 'agent' && m.author.session) sessions.add(m.author.session);
      const qs = (questionsByMessage.get(m.id) ?? []).sort((a, b) => a.position - b.position);
      for (const q of qs) {
        if (q.asked_by_agent_id) sessions.add(q.asked_by_agent_id);
        const state = fold.questionState(q);
        // As the Inbox lists them: open items wait on the person, and so does a
        // picked answer (it still has to be sent) — but not a picked action item,
        // which only sits in its Undo window.
        const waits = state === 'open' || (state === 'picked' && q.kind !== 'action');
        if (!waits) continue;
        questions.push({
          id: q.id,
          messageId: m.id,
          kind: q.kind,
          prompt: clip(q.prompt.trim()),
          stopped: q.stopped,
          holdsUp: q.holds_up,
          askedAt: m.created_at,
          askedBy: q.asked_by_agent_id ?? (m.author.kind === 'agent' ? m.author.session : null),
          state: state as 'open' | 'picked',
        });
      }
    }

    // Unseen agent messages: past the person's seen mark and their last real reply.
    const archived = root.resolved_at != null;
    let seen = root.person_seen_seq ?? 0;
    for (const m of members) {
      if (m.author.kind === 'person' && !isNote(m)) seen = Math.max(seen, seqOf(m));
    }
    const unseenMessages = members
      .filter((m) => m.author.kind === 'agent' && seqOf(m) > seen && !(archived && fold.closedByArchive(m)))
      .map((m) => ({ id: m.id, session: m.author.kind === 'agent' ? m.author.session : null }));

    if (questions.length === 0 && unseenMessages.length === 0) continue;
    const { firstMessageId, ...counts } = tally(questions);
    out.push({
      threadId,
      projectKey,
      subject: clip((root.thread_name ?? root.subject ?? '').trim(), 120) || null,
      ...counts,
      unseen: unseenMessages.length,
      lastAt: members[members.length - 1]!.created_at,
      linkMessageId: firstMessageId ?? unseenMessages[0]?.id ?? null,
      questions,
      sessions: [...sessions],
      unseenMessages,
    });
  }
  return out;
}

// ── card ────────────────────────────────────────────────────────────────────

/**
 * A thread as one card sees it: only the questions and messages of the card's
 * own sessions (another session may have replied into the thread and asked
 * there). Null when nothing of theirs is left.
 */
function narrow(t: ThreadSummary, ids: Set<string>): InboxThreadRef | null {
  const questions = t.questions.filter((q) => q.askedBy !== null && ids.has(q.askedBy));
  const unseen = t.unseenMessages.filter((m) => m.session !== null && ids.has(m.session));
  if (questions.length === 0 && unseen.length === 0) return null;
  const { firstMessageId, ...counts } = tally(questions);
  const { sessions: _s, unseenMessages: _u, ...rest } = t;
  return {
    ...rest,
    ...counts,
    unseen: unseen.length,
    linkMessageId: firstMessageId ?? unseen[0]?.id ?? null,
    questions,
  };
}

/**
 * The card's Inbox state: what its own sessions asked or wrote, by Claude
 * session id only. A message's `base_path` (the folder it was sent from) is
 * not used: any session can name any folder, and a card must not show another
 * session's message as its own (scripts/inbox-guard.mjs refuses such sends
 * too). An open question or action item, or an answer still to send, makes the
 * card wait on the person (`waiting.tool = 'Inbox'`) unless it already waits
 * on something older.
 */
export function attachInbox(unit: WorkUnitDoc, threads: ThreadSummary[]): WorkUnitDoc {
  const ids = new Set(unit.sessionIds);
  const mine = threads
    .filter((t) => t.sessions.some((s) => ids.has(s)))
    .map((t) => narrow(t, ids))
    .filter((t): t is InboxThreadRef => t !== null)
    .sort((a, b) => (b.stopped ? 1 : 0) - (a.stopped ? 1 : 0) || (b.lastAt > a.lastAt ? 1 : -1));
  if (mine.length === 0) return unit.inbox ? { ...unit, inbox: null } : unit;

  const waitingThreads = mine.filter((t) => t.questions.length > 0);
  const since = waitingThreads.reduce<string | null>((acc, t) => (t.since && (!acc || t.since < acc) ? t.since : acc), null);
  const inbox: InboxCardState = {
    needsYou: waitingThreads.length > 0,
    stopped: mine.some((t) => t.stopped !== null),
    since,
    threads: mine,
  };

  let waiting: WaitingState | null = unit.waiting;
  if (inbox.needsYou && since && (!waiting || since < waiting.since)) {
    const oldest = waitingThreads.flatMap((t) => t.questions).find((q) => q.askedAt === since)!;
    waiting = { active: true, tool: 'Inbox', since, sessionId: oldest.askedBy! };
  }
  return { ...unit, inbox, waiting };
}

// ── reading the files ───────────────────────────────────────────────────────

const LOG_FILES = ['project.json', 'messages.jsonl', 'questions.jsonl'] as const;

interface FileMark {
  offset: number;
  inode: number;
}

/** inbox.json, minus its token. */
export interface InboxRegistry {
  url: string;
  port: number;
  serverSession: string;
  version: string;
}

export function readInboxRegistry(dataDir: string): InboxRegistry | null {
  try {
    const o = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as Record<string, unknown>;
    const port = o.port;
    if (o.v !== 1 || typeof o.url !== 'string' || typeof port !== 'number' || !(port > 0 && port < 65536)) return null;
    return {
      url: o.url,
      port,
      serverSession: typeof o.serverSession === 'string' ? o.serverSession : '',
      version: typeof o.version === 'string' ? o.version : '',
    };
  } catch {
    return null;
  }
}

/** Whether the Inbox named by `reg` answers (its health carries the same serverSession). */
export async function inboxRunning(reg: InboxRegistry, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${reg.port}/api/inbox/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { serverSession?: unknown };
    return !reg.serverSession || body.serverSession === reg.serverSession;
  } catch {
    return false;
  }
}

/**
 * Tails every Inbox project folder whose root is in `roots` and keeps each one
 * folded. poll() reads what was appended since the last call; a file that was
 * replaced or shrank (thread deleted) re-reads its project from the start, a
 * folder that vanished (project deleted) is dropped.
 */
export class InboxReader {
  private folds = new Map<string, InboxFold>(); // folder name → fold
  private marks = new Map<string, FileMark>(); // file path → read position
  private others = new Set<string>(); // folders of other repositories' projects: never read again
  private warned = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly roots: Set<string>,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(msg);
  }

  /** Read new lines. Returns whether any project's records changed. */
  poll(): boolean {
    const base = join(this.dataDir, 'inbox', 'projects');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      dirs = []; // no Inbox on this machine (yet)
    }
    let changed = false;
    for (const name of [...this.folds.keys()]) {
      if (!dirs.includes(name)) {
        this.drop(base, name);
        changed = true;
      }
    }
    for (const name of [...this.others]) if (!dirs.includes(name)) this.others.delete(name);
    for (const name of dirs) {
      if (this.others.has(name)) continue;
      try {
        if (this.pollProject(base, name)) changed = true;
      } catch (e) {
        this.warnOnce(`project:${name}`, `inbox: can't read project ${name}: ${(e as Error)?.message}`);
      }
    }
    return changed;
  }

  private drop(base: string, name: string): void {
    this.folds.delete(name);
    for (const f of LOG_FILES) this.marks.delete(join(base, name, f));
  }

  private pollProject(base: string, name: string): boolean {
    const dir = join(base, name);
    // A file replaced or cut short means records were removed: start over.
    const reset = LOG_FILES.some((f) => {
      const mark = this.marks.get(join(dir, f));
      if (!mark) return false;
      try {
        const st = statSync(join(dir, f));
        return st.ino !== mark.inode || st.size < mark.offset;
      } catch {
        return true;
      }
    });
    if (reset) this.drop(base, name);

    let fold = this.folds.get(name);
    const fresh = !fold;
    fold ??= new InboxFold();
    let changed = false;
    for (const f of LOG_FILES) {
      const path = join(dir, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue; // a project with no questions yet has no questions.jsonl
      }
      const mark = this.marks.get(path) ?? { offset: 0, inode: st.ino };
      if (st.size <= mark.offset) continue;
      const { lines, consumedBytes } = parseComplete(readRange(path, mark.offset, st.size));
      this.marks.set(path, { offset: mark.offset + consumedBytes, inode: st.ino });
      for (const raw of lines) {
        const { line, badVersion } = parseInboxLine(raw);
        if (badVersion !== undefined) {
          this.warnOnce(`v${badVersion}`, `inbox: skipping records of version ${badVersion} (this reader knows version 1)`);
        }
        if (!line) continue;
        fold.apply(line);
        changed = true;
      }
    }
    // Only the board's repository: another repo's Inbox project is not read again.
    if (fold.project && !this.roots.has(fold.project.root)) {
      const had = this.folds.has(name);
      this.drop(base, name);
      this.others.add(name);
      return had;
    }
    if (fresh) this.folds.set(name, fold);
    return changed || reset;
  }

  /** Every thread with something for the person, across the board's projects. */
  threads(): ThreadSummary[] {
    return [...this.folds.entries()].flatMap(([name, fold]) => summarizeThreads(fold, fold.project?.key ?? name));
  }
}
