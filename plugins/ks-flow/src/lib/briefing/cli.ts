// lib/briefing/cli.ts — what `ks-flow briefing …` does, apart from argv and
// printing (briefing-cli.ts). Every function takes the store and a clock, so
// the tests run it against the memory store.
//
// The master's only write path. There is deliberately no archive, delete or
// un-archive here: only the person archives, on the board. `add` never touches
// an archived item and never moves a due time the person set.
import { randomUUID } from 'node:crypto';
import type { BriefingSettings } from '../boardsettings.js';
import type {
  BriefingItemDoc,
  BriefingKind,
  BriefingRunDoc,
  BriefingStore,
  DailyLogDoc,
  DueChange,
  DueRule,
  ProjectDoc,
  SlackRef,
  WorkUnitDoc,
} from '../db/types.js';
import { clockStartFor, dueFor } from './escalation.js';
import { groupKeyOf, inThread, itemUid, keyOf } from './keys.js';

export interface BriefingEnv {
  store: BriefingStore;
  projectId: string;
  settings: BriefingSettings;
  now: () => Date;
}

/** A usage or input error: the CLI prints it and exits 2. */
export class InputError extends Error {}
/** The thing named doesn't exist (or can't be changed): exit 1. */
export class NotFoundError extends Error {}

const KINDS: BriefingKind[] = ['ask', 'promise', 'fyi'];
const RULES: DueRule[] = ['message', 'promise', 'dm', 'mention', 'fyi', 'manual'];
const TRIGGERS: BriefingRunDoc['trigger'][] = ['schedule', 'button', 'log-in', 'log-off', 'manual'];
const ARCHIVED_RECENT_DAYS = 14;

/** An ISO time, normalised to UTC `…Z` so stored times sort as text. */
function iso(v: unknown, what: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new InputError(`${what}: not an ISO time (${JSON.stringify(v)})`);
  return new Date(t).toISOString();
}

function str(v: unknown, what: string, opts: { empty?: boolean } = {}): string {
  if (typeof v !== 'string' || (!opts.empty && v.trim() === '')) throw new InputError(`${what}: expected a non-empty string`);
  return v;
}

function strOrNull(v: unknown, what: string): string | null {
  return v === undefined || v === null ? null : str(v, what);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── context ─────────────────────────────────────────────────────────────────

export interface BoardUnitSummary {
  identifier: string;
  title: string;
  phase: string | null;
  linearStatus: string | null;
  waiting: { tool: string; since: string } | null;
  inbox: { needsYou: boolean; stopped: boolean; open: number; picked: number; subjects: string[] } | null;
  pr: string | null;
  worktreeDir: string | null;
  liveSessions: { pid: number; sessionId: string; tmuxPane: string | null; startedAt: string }[];
}

export interface BoardSummary {
  units: BoardUnitSummary[];
  /** Inbox questions still unanswered across those units. */
  inboxOpen: number;
}

/** The cards the board shows (worktree still a git worktree — Done ones too) and
 * any unit with a Claude process running, in the shape the master reads. */
export function boardSummary(project: ProjectDoc | null, units: WorkUnitDoc[]): BoardSummary {
  const live = new Set(project?.worktreePaths ?? []);
  const shown = units
    .filter((u) => (u.worktreeDir && live.has(u.worktreeDir)) || (u.liveSessions?.length ?? 0) > 0)
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
  let inboxOpen = 0;
  const out = shown.map((u): BoardUnitSummary => {
    const threads = u.inbox?.threads ?? [];
    const open = threads.reduce((n, t) => n + t.open, 0);
    inboxOpen += open;
    return {
      identifier: u.identifier,
      title: u.title,
      phase: u.currentPhase?.name ?? null,
      linearStatus: u.linearStatus,
      waiting: u.waiting?.active ? { tool: u.waiting.tool, since: u.waiting.since } : null,
      inbox: u.inbox
        ? {
            needsYou: u.inbox.needsYou,
            stopped: u.inbox.stopped,
            open,
            picked: threads.reduce((n, t) => n + t.picked, 0),
            subjects: threads.map((t) => t.subject).filter((s): s is string => !!s),
          }
        : null,
      pr: u.pr?.url ?? null,
      worktreeDir: u.worktreeDir,
      liveSessions: (u.liveSessions ?? []).map((s) => ({
        pid: s.pid,
        sessionId: s.sessionId,
        tmuxPane: s.tmuxPane,
        startedAt: s.startedAt,
      })),
    };
  });
  return { units: out, inboxOpen };
}

export interface BriefingContext {
  now: string;
  /** Where the next pass starts reading Slack: the newest successful run's cursor. */
  cursor: string | null;
  lastRun: BriefingRunDoc | null;
  settings: Pick<BriefingSettings, 'names' | 'halfTime' | 'schedule'>;
  open: BriefingItemDoc[];
  knownKeys: string[];
  archivedRecent: BriefingItemDoc[];
  board: BoardSummary;
}

const byDue = (a: BriefingItemDoc, b: BriefingItemDoc) => a.dueAt.localeCompare(b.dueAt);

export async function context(env: BriefingEnv, board: BoardSummary): Promise<BriefingContext> {
  const now = env.now();
  const [items, runs] = await Promise.all([
    env.store.getBriefingItems(env.projectId),
    env.store.getBriefingRuns(env.projectId),
  ]);
  const since = now.getTime() - ARCHIVED_RECENT_DAYS * 86_400_000;
  return {
    now: now.toISOString(),
    cursor: lastCursor(runs),
    lastRun: runs[0] ?? null,
    settings: { names: env.settings.names, halfTime: env.settings.halfTime, schedule: env.settings.schedule },
    open: items.filter((i) => i.status === 'open').sort(byDue),
    knownKeys: items.map((i) => i.key).sort(),
    archivedRecent: items
      .filter((i) => i.status === 'archived' && i.archivedAt && Date.parse(i.archivedAt) >= since)
      .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    board,
  };
}

/** Runs come newest first; a failed or unfinished run never moves the cursor. */
function lastCursor(runs: BriefingRunDoc[]): string | null {
  return runs.find((r) => r.status === 'ok' && r.slackCursor)?.slackCursor ?? null;
}

// ── find ────────────────────────────────────────────────────────────────────

export type FindBy = { group: string } | { thread: string } | { key: string };

/** Matching items, open and archived, oldest first. */
export async function find(env: BriefingEnv, by: FindBy): Promise<BriefingItemDoc[]> {
  let items: BriefingItemDoc[];
  if ('group' in by) items = await env.store.getBriefingItems(env.projectId, { groupKey: by.group });
  else {
    const all = await env.store.getBriefingItems(env.projectId);
    items =
      'key' in by
        ? all.filter((i) => i.key === by.key)
        : all.filter((i) => inThread(i.source, i.groupKey, by.thread));
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── add ─────────────────────────────────────────────────────────────────────

/** What the master hands `add`: an item minus everything the CLI derives. */
export interface BriefingItemInput {
  kind: BriefingKind;
  title: string;
  why: string;
  source: SlackRef;
  dueRule: DueRule;
  /** When absent, derived with dueFor (rule 'message' needs it). */
  dueAt?: string;
  clockStart?: string;
  receivedAt?: string;
  /** Rule 'promise' without dueAt: what was said — eod, tomorrow, none, or an ISO time. */
  promise?: 'eod' | 'tomorrow' | 'none' | string;
  /** Recorded on the dueHistory entry. */
  dueReason?: string;
  dueSetByYou?: boolean;
  fyiCap?: boolean;
  quick?: boolean;
  unit?: string | null;
  links?: { label: string; url: string }[];
  evidence?: { at: string; text: string; url?: string }[];
  /** Absent: the newest archived item of the same thread, when all of them are archived. */
  linkedTo?: string | null;
  createdBy?: 'master' | 'you';
  runId?: string | null;
}

export type AddResult =
  | { uid: string; key: string; action: 'created' | 'updated' | 'unchanged'; dueAt: string; dueChanged?: true; dueKept?: true }
  | { uid: string; key: string; skipped: 'archived' };

function parseSource(v: unknown, at: string): SlackRef {
  if (!isObj(v)) throw new InputError(`${at}.source: expected an object`);
  const from = v.from;
  if (!isObj(from)) throw new InputError(`${at}.source.from: expected { id, name }`);
  const threadTs = strOrNull(v.threadTs, `${at}.source.threadTs`);
  return {
    channel: str(v.channel, `${at}.source.channel`),
    channelName: strOrNull(v.channelName, `${at}.source.channelName`),
    ts: str(v.ts, `${at}.source.ts`),
    threadTs: threadTs === v.ts ? null : threadTs, // a root's own ts is not a parent
    messageUrl: str(v.messageUrl, `${at}.source.messageUrl`),
    threadUrl: strOrNull(v.threadUrl, `${at}.source.threadUrl`),
    from: { id: str(from.id, `${at}.source.from.id`), name: str(from.name, `${at}.source.from.name`) },
    text: str(v.text, `${at}.source.text`, { empty: true }),
    sentAt: iso(v.sentAt, `${at}.source.sentAt`),
  };
}

function parseLinks(v: unknown, at: string): { label: string; url: string }[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${at}.links: expected an array`);
  return v.map((l, i) => {
    if (!isObj(l)) throw new InputError(`${at}.links[${i}]: expected { label, url }`);
    return { label: str(l.label, `${at}.links[${i}].label`), url: str(l.url, `${at}.links[${i}].url`) };
  });
}

function parseEvidence(v: unknown, at: string): BriefingItemDoc['evidence'] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new InputError(`${at}.evidence: expected an array`);
  return v.map((e, i) => {
    if (!isObj(e)) throw new InputError(`${at}.evidence[${i}]: expected { at, text, url? }`);
    const url = e.url === undefined ? undefined : str(e.url, `${at}.evidence[${i}].url`);
    return { at: iso(e.at, `${at}.evidence[${i}].at`), text: str(e.text, `${at}.evidence[${i}].text`), ...(url ? { url } : {}) };
  });
}

/** Check one input item and normalise its times. Throws InputError. */
export function parseInput(v: unknown, at = 'item'): BriefingItemInput {
  if (!isObj(v)) throw new InputError(`${at}: expected an object`);
  for (const derived of ['uid', 'groupKey', 'dueHistory', 'pushedCount', 'notified', 'status', 'archivedAt', 'resolution', 'archiveNote', 'createdAt', 'updatedAt'])
    if (v[derived] !== undefined) throw new InputError(`${at}.${derived}: derived by the CLI, leave it out`);
  if (!KINDS.includes(v.kind as BriefingKind)) throw new InputError(`${at}.kind: one of ${KINDS.join(', ')}`);
  if (!RULES.includes(v.dueRule as DueRule)) throw new InputError(`${at}.dueRule: one of ${RULES.join(', ')}`);
  const source = parseSource(v.source, at);
  if (v.key !== undefined && v.key !== keyOf(source))
    throw new InputError(`${at}.key: ${JSON.stringify(v.key)} doesn't match its source (${keyOf(source)})`);
  const promise = v.promise;
  if (promise !== undefined && !['eod', 'tomorrow', 'none'].includes(promise as string)) iso(promise, `${at}.promise`);
  const bool = (k: string) => {
    if (v[k] !== undefined && typeof v[k] !== 'boolean') throw new InputError(`${at}.${k}: expected true or false`);
    return v[k] as boolean | undefined;
  };
  if (v.createdBy !== undefined && v.createdBy !== 'master' && v.createdBy !== 'you')
    throw new InputError(`${at}.createdBy: master or you`);
  return {
    kind: v.kind as BriefingKind,
    title: str(v.title, `${at}.title`),
    why: str(v.why, `${at}.why`),
    source,
    dueRule: v.dueRule as DueRule,
    dueAt: v.dueAt === undefined ? undefined : iso(v.dueAt, `${at}.dueAt`),
    clockStart: v.clockStart === undefined ? undefined : iso(v.clockStart, `${at}.clockStart`),
    receivedAt: v.receivedAt === undefined ? undefined : iso(v.receivedAt, `${at}.receivedAt`),
    promise: promise as BriefingItemInput['promise'],
    dueReason: v.dueReason === undefined ? undefined : str(v.dueReason, `${at}.dueReason`),
    dueSetByYou: bool('dueSetByYou'),
    fyiCap: bool('fyiCap'),
    quick: bool('quick'),
    unit: v.unit === undefined ? undefined : strOrNull(v.unit, `${at}.unit`),
    links: parseLinks(v.links, at),
    evidence: parseEvidence(v.evidence, at),
    linkedTo: v.linkedTo === undefined ? undefined : strOrNull(v.linkedTo, `${at}.linkedTo`),
    createdBy: v.createdBy as BriefingItemInput['createdBy'],
    runId: v.runId === undefined ? undefined : strOrNull(v.runId, `${at}.runId`),
  };
}

/** The input's due time: its own, else dueFor from the rule. */
function dueOf(input: BriefingItemInput, receivedAt: string, halfTime: boolean): { clockStart: string; dueAt: string } {
  const received = new Date(receivedAt);
  if (input.dueAt) {
    return { clockStart: input.clockStart ?? clockStartFor(received).toISOString(), dueAt: input.dueAt };
  }
  if (input.dueRule === 'message') throw new InputError(`${keyOf(input.source)}: rule 'message' needs dueAt (the deadline the message gives)`);
  const p = input.promise;
  const r = dueFor({
    rule: input.dueRule,
    receivedAt: received,
    promise: p === undefined || p === 'eod' || p === 'tomorrow' || p === 'none' ? p : new Date(p),
    halfTime,
  });
  return { clockStart: input.clockStart ?? r.clockStart.toISOString(), dueAt: r.dueAt.toISOString() };
}

function mergeLinks(old: BriefingItemDoc['links'], add: BriefingItemDoc['links']): BriefingItemDoc['links'] {
  const out = [...old];
  for (const l of add) {
    const i = out.findIndex((o) => o.url === l.url);
    if (i < 0) out.push(l);
    else out[i] = l; // the newer label wins
  }
  return out;
}

function mergeEvidence(old: BriefingItemDoc['evidence'], add: BriefingItemDoc['evidence']): BriefingItemDoc['evidence'] {
  const seen = new Set(old.map((e) => `${e.text}\u0000${e.url ?? ''}`));
  return [...old, ...add.filter((e) => !seen.has(`${e.text}\u0000${e.url ?? ''}`))];
}

/** Upsert each input in turn (see the contract's `add` rules). */
export async function add(env: BriefingEnv, inputs: BriefingItemInput[]): Promise<AddResult[]> {
  const results: AddResult[] = [];
  for (const input of inputs) results.push(await addOne(env, input));
  return results;
}

async function addOne(env: BriefingEnv, input: BriefingItemInput): Promise<AddResult> {
  const now = env.now().toISOString();
  const key = keyOf(input.source);
  const uid = itemUid(key);
  const halfTime = env.settings.halfTime.includes(input.source.from.id);
  const existing = await env.store.getBriefingItem(env.projectId, uid);

  if (!existing) {
    const groupKey = groupKeyOf(input.source);
    let linkedTo = input.linkedTo;
    if (linkedTo === undefined) {
      const group = await env.store.getBriefingItems(env.projectId, { groupKey });
      const archived = group.filter((i) => i.status === 'archived');
      linkedTo =
        group.length && archived.length === group.length
          ? archived.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))[0].uid
          : null;
    }
    const receivedAt = input.receivedAt ?? input.source.sentAt;
    const { clockStart, dueAt } = dueOf(input, receivedAt, halfTime);
    const createdBy = input.createdBy ?? 'master';
    const first: DueChange = { at: now, from: null, to: dueAt, by: createdBy, ...(input.dueReason ? { reason: input.dueReason } : {}) };
    const doc: BriefingItemDoc = {
      uid,
      key,
      groupKey,
      kind: input.kind,
      title: input.title,
      why: input.why,
      source: input.source,
      receivedAt,
      clockStart,
      dueAt,
      dueRule: input.dueRule,
      dueSetByYou: input.dueSetByYou ?? false,
      dueHistory: [first],
      pushedCount: 0,
      fyiCap: input.fyiCap ?? input.kind === 'fyi',
      quick: input.quick ?? false,
      unit: input.unit ?? null,
      links: input.links ?? [],
      evidence: input.evidence ?? [],
      linkedTo,
      status: 'open',
      archivedAt: null,
      resolution: null,
      archiveNote: null,
      createdBy,
      runId: input.runId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await env.store.upsertBriefingItem(env.projectId, doc);
    return { uid, key, action: 'created', dueAt };
  }

  if (existing.status === 'archived') return { uid, key, skipped: 'archived' };

  const doc: BriefingItemDoc = { ...existing };
  if (input.title !== doc.title) doc.title = input.title;
  if (input.why !== doc.why) doc.why = input.why;
  if (input.quick !== undefined) doc.quick = input.quick;
  if (input.unit !== undefined) doc.unit = input.unit;
  if (input.links) doc.links = mergeLinks(doc.links, input.links);
  if (input.evidence) doc.evidence = mergeEvidence(doc.evidence, input.evidence);

  // The due time moves only when the input says something new about it —
  // its own dueAt, a promise, or another rule — and never once the person set it.
  let dueChanged = false;
  let dueKept = false;
  if (input.dueAt !== undefined || input.promise !== undefined || input.dueRule !== existing.dueRule) {
    if (existing.dueSetByYou) dueKept = true;
    else {
      const next = dueOf(input, existing.receivedAt, halfTime);
      if (Date.parse(next.dueAt) !== Date.parse(existing.dueAt)) {
        doc.dueHistory = [
          ...existing.dueHistory,
          { at: now, from: existing.dueAt, to: next.dueAt, by: 'master', ...(input.dueReason ? { reason: input.dueReason } : {}) },
        ];
        doc.dueAt = next.dueAt;
        dueChanged = true;
      }
      // A due change re-arms the daemon's notices by itself: the new
      // dueHistory entry voids every notice sent before it (notices.armedAt).
      if (input.clockStart !== undefined) doc.clockStart = input.clockStart;
      doc.dueRule = input.dueRule;
    }
  }

  const same = JSON.stringify(doc) === JSON.stringify(existing);
  if (!same) {
    // Re-read right before the write: the person may have archived the item
    // on the board since the read above. Residual race: the store has no
    // transaction (PocketBase REST), so an archive landing between this read
    // and the write below is still overwritten — a window of milliseconds.
    if ((await env.store.getBriefingItem(env.projectId, uid))?.status === 'archived')
      return { uid, key, skipped: 'archived' };
    doc.updatedAt = now;
    await env.store.upsertBriefingItem(env.projectId, doc);
  }
  return {
    uid,
    key,
    action: same ? 'unchanged' : 'updated',
    dueAt: doc.dueAt,
    ...(dueChanged ? { dueChanged: true as const } : {}),
    ...(dueKept ? { dueKept: true as const } : {}),
  };
}

// ── evidence ────────────────────────────────────────────────────────────────

export async function evidence(
  env: BriefingEnv,
  uid: string,
  text: string,
  url?: string,
): Promise<{ uid: string; evidence: BriefingItemDoc['evidence'] } | { uid: string; skipped: 'archived' }> {
  const doc = await env.store.getBriefingItem(env.projectId, uid);
  if (!doc) throw new NotFoundError(`no briefing item ${uid}`);
  if (doc.status === 'archived') return { uid, skipped: 'archived' };
  const now = env.now().toISOString();
  doc.evidence = [...doc.evidence, { at: now, text, ...(url ? { url } : {}) }];
  doc.updatedAt = now;
  // Re-read right before the write (see addOne): skip an item archived since.
  // Residual race: no transaction in the store, so an archive in the gap
  // between this read and the write is still overwritten.
  if ((await env.store.getBriefingItem(env.projectId, uid))?.status === 'archived') return { uid, skipped: 'archived' };
  await env.store.upsertBriefingItem(env.projectId, doc);
  return { uid, evidence: doc.evidence };
}

// ── runs ────────────────────────────────────────────────────────────────────

export async function runStart(
  env: BriefingEnv,
  trigger: string,
  slot: string | null,
): Promise<BriefingRunDoc & { previousCursor: string | null }> {
  if (!TRIGGERS.includes(trigger as BriefingRunDoc['trigger']))
    throw new InputError(`--trigger: one of ${TRIGGERS.join(', ')}`);
  if (slot !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot)) throw new InputError('--slot: HH:MM');
  const previousCursor = lastCursor(await env.store.getBriefingRuns(env.projectId));
  const run: BriefingRunDoc = {
    uid: randomUUID(),
    trigger: trigger as BriefingRunDoc['trigger'],
    slot,
    startedAt: env.now().toISOString(),
    endedAt: null,
    status: 'running',
    slackCursor: null,
    added: 0,
    updated: 0,
    summary: null,
    error: null,
  };
  await env.store.upsertBriefingRun(env.projectId, run);
  return { ...run, previousCursor };
}

export async function runFinish(
  env: BriefingEnv,
  uid: string,
  r: { cursor?: string; added: number; updated: number; summary?: string; failed?: string },
): Promise<BriefingRunDoc> {
  const run = await env.store.getBriefingRun(env.projectId, uid);
  if (!run) throw new NotFoundError(`no briefing run ${uid}`);
  if (run.status !== 'running') throw new NotFoundError(`run ${uid} already finished (${run.status})`);
  if (r.cursor === undefined && r.failed === undefined) throw new InputError('--cursor is required (unless --failed)');
  for (const [k, n] of [['added', r.added], ['updated', r.updated]] as const)
    if (!Number.isInteger(n) || n < 0) throw new InputError(`--${k}: a whole number ≥ 0`);
  const done: BriefingRunDoc = {
    ...run,
    endedAt: env.now().toISOString(),
    status: r.failed === undefined ? 'ok' : 'failed',
    slackCursor: r.cursor === undefined ? null : iso(r.cursor, '--cursor'),
    added: r.added,
    updated: r.updated,
    summary: r.summary ?? null,
    error: r.failed ?? null,
  };
  await env.store.upsertBriefingRun(env.projectId, done);
  return done;
}

// ── daily log ───────────────────────────────────────────────────────────────

function checkDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)))
    throw new InputError(`${JSON.stringify(date)}: expected YYYY-MM-DD`);
  return date;
}

function parseSessions(v: unknown): DailyLogDoc['sessions'] {
  if (!Array.isArray(v)) throw new InputError('sessions: expected an array');
  return v.map((s, i) => {
    if (!isObj(s)) throw new InputError(`sessions[${i}]: expected an object`);
    const suggestion = s.suggestion === undefined || s.suggestion === null ? undefined : str(s.suggestion, `sessions[${i}].suggestion`);
    return {
      unit: str(s.unit, `sessions[${i}].unit`),
      sessionId: strOrNull(s.sessionId, `sessions[${i}].sessionId`),
      phase: strOrNull(s.phase, `sessions[${i}].phase`),
      state: str(s.state, `sessions[${i}].state`),
      lastDid: str(s.lastDid, `sessions[${i}].lastDid`, { empty: true }),
      ...(suggestion ? { suggestion } : {}),
    };
  });
}

/** Write the log-in or log-off part of a day. The report's `sessions` (when
 * present) become the day's roll call; its `at` (else now) the part's time. */
export async function dailySet(
  env: BriefingEnv,
  date: string,
  part: string,
  report: unknown,
): Promise<DailyLogDoc> {
  checkDate(date);
  if (part !== 'log-in' && part !== 'log-off') throw new InputError('--part: log-in or log-off');
  if (!isObj(report)) throw new InputError('the report must be a JSON object');
  const now = env.now().toISOString();
  const at = report.at === undefined ? now : iso(report.at, 'at');
  const doc: DailyLogDoc = (await env.store.getDailyLog(env.projectId, date)) ?? {
    uid: date,
    date,
    logInAt: null,
    logOffAt: null,
    logIn: null,
    logOff: null,
    sessions: [],
    updatedAt: now,
  };
  if (part === 'log-in') {
    doc.logIn = report;
    doc.logInAt = at;
  } else {
    doc.logOff = report;
    doc.logOffAt = at;
  }
  if (report.sessions !== undefined) doc.sessions = parseSessions(report.sessions);
  doc.updatedAt = now;
  await env.store.upsertDailyLog(env.projectId, doc);
  return doc;
}

export async function dailyGet(env: BriefingEnv, date?: string): Promise<DailyLogDoc | null> {
  return env.store.getDailyLog(env.projectId, checkDate(date ?? localDate(env.now())));
}
