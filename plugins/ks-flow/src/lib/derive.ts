// lib/derive.ts — per-session accumulator + waiting/activity overlay.
//
// JSONL is the source of truth; events.jsonl is an ENRICHMENT overlay, never a
// second authority. This module is PURE (no fs/git/clock) so re-ingesting a
// file from offset 0 reproduces identical state — safe crash recovery.
import type { OpenAsk, OverlayWait, PrRef, SessionDoc } from './db/types.js';

const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export interface SessionAcc {
  sessionId: string;
  filePath: string;
  projectDir: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstActivity: string | null;
  lastActivity: string | null; // last line WITH a timestamp
  userMsgs: number;
  assistantMsgs: number;
  version: string | null;
  entrypoint: string | null;
  pr: PrRef | null;
  openAsks: Map<string, OpenAsk>; // toolUseId → ask
  overlayWaits: Map<string, OverlayWait>; // overlayId → permission/elicitation
}

export function newAcc(
  sessionId: string,
  filePath: string,
  projectDir: string,
): SessionAcc {
  return {
    sessionId,
    filePath,
    projectDir,
    cwd: null,
    gitBranch: null,
    title: null,
    firstActivity: null,
    lastActivity: null,
    userMsgs: 0,
    assistantMsgs: 0,
    version: null,
    entrypoint: null,
    pr: null,
    openAsks: new Map(),
    overlayWaits: new Map(),
  };
}

function asArray(content: unknown): unknown[] {
  // message.content is sometimes a string, sometimes an array — guard always
  // or the parser throws and a session sticks "waiting" forever.
  return Array.isArray(content) ? content : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Fold one parsed JSONL record into the accumulator. */
export function applyLine(acc: SessionAcc, line: unknown): void {
  if (typeof line !== 'object' || line === null) return;
  const rec = line as Record<string, unknown>;
  const type = str(rec.type);

  if (type === 'ai-title') {
    acc.title = str(rec.aiTitle) ?? acc.title;
    return;
  }

  if (type === 'pr-link') {
    const url = str(rec.prUrl);
    if (url) {
      acc.pr = {
        number: typeof rec.prNumber === 'number' ? rec.prNumber : null,
        url,
        repo: str(rec.prRepository),
      };
    }
    return;
  }

  if (type !== 'user' && type !== 'assistant') return;

  const cwd = str(rec.cwd);
  if (cwd) acc.cwd = cwd;
  const branch = str(rec.gitBranch);
  if (branch) acc.gitBranch = branch;
  acc.version = str(rec.version) ?? acc.version;
  acc.entrypoint = str(rec.entrypoint) ?? acc.entrypoint;

  const ts = str(rec.timestamp);
  if (ts) {
    if (acc.firstActivity === null || ts < acc.firstActivity) acc.firstActivity = ts;
    if (acc.lastActivity === null || ts > acc.lastActivity) acc.lastActivity = ts;
    // Forward progress: a newer JSONL line means the human responded → clear
    // permission/elicitation overlays older than this line. (Only overlays;
    // asks clear strictly on their matching tool_result, never on "any newer".)
    for (const [id, w] of acc.overlayWaits) {
      if (!w.cleared && w.since < ts) acc.overlayWaits.set(id, { ...w, cleared: true });
    }
  }

  if (type === 'user') acc.userMsgs += 1;
  else acc.assistantMsgs += 1;

  const message = rec.message as Record<string, unknown> | undefined;
  const blocks = asArray(message?.content);
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as Record<string, unknown>;
    const btype = str(block.type);
    if (btype === 'tool_use') {
      const id = str(block.id);
      const name = str(block.name);
      if (id && name && ASK_TOOLS.has(name) && ts) {
        acc.openAsks.set(id, { toolUseId: id, tool: name, since: ts });
      }
    } else if (btype === 'tool_result') {
      const id = str(block.tool_use_id);
      if (id) acc.openAsks.delete(id); // the ONLY thing that clears an ask
    }
  }
}

/** Record a permission/elicitation overlay wait from events.jsonl. */
export function addOverlay(acc: SessionAcc, overlayId: string, kind: string, since: string): void {
  if (acc.overlayWaits.has(overlayId)) return;
  // If activity already advanced past this overlay, it's already resolved.
  const cleared = acc.lastActivity !== null && acc.lastActivity > since;
  acc.overlayWaits.set(overlayId, { overlayId, kind, since, cleared });
}

export interface Waiting {
  active: boolean;
  tool: string | null;
  since: string | null;
}

/**
 * Compute the waiting badge + the oldest blocking tool. TTL-expires overlays
 * (a permission prompt the user walked away from) so a card doesn't wait
 * forever. `nowMs` and `ttlMs`/`overlay` are passed in to keep this pure.
 */
export function resolveWaiting(acc: SessionAcc, nowMs: number, overlayTtlMs: number): Waiting {
  const candidates: Array<{ tool: string; since: string }> = [];
  for (const a of acc.openAsks.values()) candidates.push({ tool: a.tool, since: a.since });
  for (const w of acc.overlayWaits.values()) {
    if (w.cleared) continue;
    if (nowMs - Date.parse(w.since) > overlayTtlMs) continue; // TTL expiry
    candidates.push({ tool: w.kind, since: w.since });
  }
  if (candidates.length === 0) return { active: false, tool: null, since: null };
  candidates.sort((a, b) => (a.since < b.since ? -1 : 1)); // oldest first
  return { active: true, tool: candidates[0].tool, since: candidates[0].since };
}

export function activityOf(acc: SessionAcc, nowMs: number, idleMs: number): 'active' | 'idle' {
  if (acc.lastActivity === null) return 'idle';
  return nowMs - Date.parse(acc.lastActivity) > idleMs ? 'idle' : 'active';
}

export interface MaterializeOpts {
  nowMs: number;
  idleMs: number;
  overlayTtlMs: number;
  worktreePath: string | null;
  inProject: boolean;
  nowIso: string;
}

/** Snapshot the accumulator into a provider-agnostic SessionDoc. */
export function materialize(acc: SessionAcc, opts: MaterializeOpts): SessionDoc {
  const waiting = resolveWaiting(acc, opts.nowMs, opts.overlayTtlMs);
  return {
    sessionId: acc.sessionId,
    unitId: null, // assigned by the join step
    title: acc.title,
    cwd: acc.cwd,
    gitBranch: acc.gitBranch,
    worktreePath: opts.worktreePath,
    projectDir: acc.projectDir,
    filePath: acc.filePath,
    firstActivity: acc.firstActivity,
    lastActivity: acc.lastActivity,
    userMsgs: acc.userMsgs,
    assistantMsgs: acc.assistantMsgs,
    version: acc.version,
    entrypoint: acc.entrypoint,
    activity: activityOf(acc, opts.nowMs, opts.idleMs),
    waitingSince: waiting.since,
    waitingTool: waiting.tool,
    pr: acc.pr,
    openAsks: [...acc.openAsks.values()],
    overlayWaits: [...acc.overlayWaits.values()],
    inProject: opts.inProject,
    archived: false,
    updatedAt: opts.nowIso,
  };
}
