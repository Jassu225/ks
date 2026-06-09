#!/usr/bin/env node
// daemon.ts — the ks-flow ingester. Always-on (launchd), single project.
//
// Pipeline:
//   backfill (worktree-enumerated projects/ dirs) → chokidar tail of session
//   JSONL + events.jsonl + workflow/**/state.yaml → derive → join → store.
// Only the daemon writes to the DB. Ingestion bookkeeping stays local
// (checkpoints.json); only derived documents go to the store.
import chokidar from 'chokidar';
import { createWriteStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import type { SessionDoc, SessionWriter, WorkUnitDoc } from './lib/db/types.js';
import {
  addOverlay,
  applyLine,
  materialize,
  newAcc,
  type SessionAcc,
} from './lib/derive.js';
import { parseComplete, readRange } from './lib/jsonl.js';
import { Checkpoints } from './lib/checkpoints.js';
import { startPocketbase, type PbHandle } from './lib/pbserver.js';
import { currentPhase, derivePhaseModel, projectWorkflowType } from './lib/phasemodel.js';
import { joinUnit } from './lib/join.js';
import { parseStateYaml } from './lib/stateyaml.js';
import {
  CLAUDE_PROJECTS_DIR,
  DAEMON_LOG_PATH,
  encodeProjectDir,
  EVENTS_PATH,
  expandTilde,
  workflowDir,
} from './lib/paths.js';
import { isInProject, listWorktrees, toplevel } from './lib/worktree.js';

const cfg = loadConfig();
const conf = readProjectConf();
if (!conf) {
  console.error('[ks-flow] no project.conf — run bootstrap or `ks-flow set-project <path>`. Exiting.');
  process.exit(0);
}
const { projectId, commonDir: PROJECT_COMMON_DIR, projectPath } = conf;
const provider = createProvider(cfg);
const writer: SessionWriter = provider.writer();

const IDLE_MS = cfg.idleMinutes * 60_000;
const OVERLAY_TTL_MS = 10 * 60_000;

// Truncate-on-start log: open with 'w' so daemon.log holds only the current
// run. The daemon owns this file (launchd's StandardOutPath → /dev/null) to
// avoid two writers. Also mirror to stdout so `ks-flow daemon` (foreground)
// shows logs in the terminal.
const logStream = createWriteStream(DAEMON_LOG_PATH, { flags: 'w' });
function log(...a: unknown[]): void {
  const msg = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const line = `[${new Date().toISOString()}] [ks-flow] ${msg}\n`;
  logStream.write(line);
  process.stdout.write(line);
}
function nowIso(): string {
  return new Date().toISOString();
}
function sessionIdFromPath(p: string): string {
  return p.replace(/\.jsonl$/, '').split('/').pop()!;
}
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ── in-memory state ─────────────────────────────────────────────────────────
const checkpoints = new Checkpoints();
const accs = new Map<string, SessionAcc>(); // sessionId → accumulator
const sessionDocs = new Map<string, SessionDoc>(); // last materialized doc
const units = new Map<string, WorkUnitDoc>(); // stateYamlPath → work-unit
const worktreePathCache = new Map<string, string | null>(); // cwd → toplevel
const pendingOverlays = new Map<string, Array<{ id: string; kind: string; since: string }>>();
let knownWorktrees: string[] = conf.worktreePaths ?? [];
let eventsOffset = 0;
let pbHandle: PbHandle | null = null;

function worktreePathFor(cwd: string | null): string | null {
  if (!cwd) return null;
  if (worktreePathCache.has(cwd)) return worktreePathCache.get(cwd)!;
  const top = toplevel(cwd);
  worktreePathCache.set(cwd, top);
  return top;
}

// ── session ingestion ───────────────────────────────────────────────────────
/** Read new bytes of a session file, fold into its accumulator. Returns the
 * inProject decision (undefined = not yet determinable). */
function ingestSessionFile(path: string): boolean | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    const cp = checkpoints.get(path);
    if (cp) writer.markArchived(projectId, cp.sessionId).catch(() => {});
    return undefined;
  }
  const cp = checkpoints.get(path);
  const sessionId = cp?.sessionId ?? sessionIdFromPath(path);
  let start = cp?.byteOffset ?? 0;
  if (cp && (st.ino !== cp.inode || st.size < cp.byteOffset)) {
    start = 0; // truncate/replace → idempotent replay from 0
    accs.delete(sessionId);
  }
  if (st.size <= start && cp) return cp.inProject;

  let acc = accs.get(sessionId);
  if (!acc) {
    acc = newAcc(sessionId, path, path.split('/').slice(0, -1).join('/'));
    accs.set(sessionId, acc);
    drainPendingOverlays(acc);
  }

  const data = readRange(path, start, st.size);
  const { lines, consumedBytes } = parseComplete(data);
  for (const line of lines) applyLine(acc, line);

  // Membership is stable per file (cwd never changes). Cache once known.
  let inProject = cp?.inProject;
  if (inProject === undefined && acc.cwd) {
    inProject = isInProject(acc.cwd, PROJECT_COMMON_DIR, knownWorktrees);
  }

  const newOffset = consumedBytes > 0 ? start + consumedBytes : start;
  checkpoints.set(path, {
    byteOffset: newOffset,
    fileSize: st.size,
    inode: st.ino,
    sessionId,
    inProject,
  });
  return inProject;
}

function drainPendingOverlays(acc: SessionAcc): void {
  const pend = pendingOverlays.get(acc.sessionId);
  if (!pend) return;
  for (const o of pend) addOverlay(acc, o.id, o.kind, o.since);
  pendingOverlays.delete(acc.sessionId);
}

function snapshot(acc: SessionAcc, inProject: boolean): SessionDoc {
  const doc = materialize(acc, {
    nowMs: Date.now(),
    idleMs: IDLE_MS,
    overlayTtlMs: OVERLAY_TTL_MS,
    worktreePath: worktreePathFor(acc.cwd),
    inProject,
    nowIso: nowIso(),
  });
  sessionDocs.set(acc.sessionId, doc);
  return doc;
}

// ── debounced writes ────────────────────────────────────────────────────────
const sessionTimers = new Map<string, NodeJS.Timeout>();
function scheduleSessionUpsert(sessionId: string): void {
  const existing = sessionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  sessionTimers.set(
    sessionId,
    setTimeout(() => {
      sessionTimers.delete(sessionId);
      const acc = accs.get(sessionId);
      if (!acc) return;
      const doc = snapshot(acc, true);
      writer.upsertSession(projectId, doc).catch((e) => log('upsertSession failed', e?.message));
      scheduleProjectRecompute();
    }, 1000),
  );
}

let projectTimer: NodeJS.Timeout | null = null;
function scheduleProjectRecompute(): void {
  if (projectTimer) return;
  projectTimer = setTimeout(() => {
    projectTimer = null;
    recomputeProject().catch((e) => log('recomputeProject failed', e?.message));
  }, 700);
}

async function recomputeProject(): Promise<void> {
  const unitList = [...units.values()];
  const sessions = [...sessionDocs.values()].filter((s) => s.inProject);
  // phase model + per-card column
  const withPhase = unitList.map((u) => ({ ...u, currentPhase: currentPhase(u) }));

  // Dedup per unitId: every worktree carries a copy of every ticket's
  // state.yaml, so the same unit shows up many times at different progress.
  // Keep the most-advanced copy (highest current phase), preferring the one
  // whose worktree is live, then the one with more phases.
  const live = new Set(knownWorktrees);
  const isLive = (wt: string | null): boolean => !!(wt && live.has(realpathOr(wt)));
  const best = new Map<string, (typeof withPhase)[number]>();
  for (const u of withPhase) {
    const cur = best.get(u.unitId);
    if (!cur) {
      best.set(u.unitId, u);
      continue;
    }
    const a: [number, number, number] = [u.currentPhase?.number ?? -1, isLive(u.worktreeDir) ? 1 : 0, u.phases.length];
    const b: [number, number, number] = [cur.currentPhase?.number ?? -1, isLive(cur.worktreeDir) ? 1 : 0, cur.phases.length];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) {
      best.set(u.unitId, u);
    }
  }
  const deduped = [...best.values()];
  const phaseModel = derivePhaseModel(deduped);
  // join sessions onto each card
  const joined = deduped.map((u) => joinUnit(u, sessions));

  await writer.upsertProject({
    projectId,
    projectPath,
    commonDir: PROJECT_COMMON_DIR,
    workflowType: projectWorkflowType(joined),
    phaseModel,
    worktreePaths: knownWorktrees,
    updatedAt: nowIso(),
  });
  // A card is worktree-backed only if its worktreeDir is a CURRENT git worktree
  // (old state.yaml records removed worktrees; leftover dirs still exist, so
  // existsSync isn't enough). Null it otherwise so the board hides the backlog.
  for (const u of joined) {
    const worktreeDir = isLive(u.worktreeDir) ? u.worktreeDir : null;
    await writer.upsertWorkUnit(projectId, { ...u, worktreeDir, updatedAt: nowIso() });
  }
}

// ── state.yaml ingestion ────────────────────────────────────────────────────
function ingestStateYaml(path: string): void {
  const parsed = parseStateYaml(path);
  if (!parsed) return; // mid-write / malformed → keep last good
  const u: WorkUnitDoc = {
    ...parsed.doc,
    currentPhase: null,
    waiting: null,
    sessionIds: [],
    lastActivity: null,
    updatedAt: nowIso(),
  };
  units.set(path, u);
  scheduleProjectRecompute();
}

// ── events.jsonl overlay ────────────────────────────────────────────────────
function ingestEvents(): void {
  if (!existsSync(EVENTS_PATH)) return;
  const st = statSync(EVENTS_PATH);
  if (st.size < eventsOffset) eventsOffset = 0;
  if (st.size <= eventsOffset) return;
  const data = readRange(EVENTS_PATH, eventsOffset, st.size);
  const { lines, consumedBytes } = parseComplete(data);
  if (consumedBytes > 0) eventsOffset += consumedBytes;
  for (const line of lines) {
    const ev = line as Record<string, unknown>;
    const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
    const kind = typeof ev.kind === 'string' ? ev.kind : null;
    const id = typeof ev.id === 'string' ? ev.id : null;
    const since = typeof ev.ts === 'string' ? ev.ts : nowIso();
    if (!sessionId || !kind || !id) continue;
    // AskUserQuestion/ExitPlanMode are governed by the JSONL tool_use — ignore
    // them here to avoid double-counting (they carry no tool_use_id).
    if (kind !== 'PermissionRequest' && kind !== 'Elicitation') continue;
    const acc = accs.get(sessionId);
    if (acc) {
      addOverlay(acc, id, kind, since);
      scheduleSessionUpsert(sessionId);
    } else {
      const arr = pendingOverlays.get(sessionId) ?? [];
      arr.push({ id, kind, since });
      pendingOverlays.set(sessionId, arr);
    }
  }
}

// ── backfill ────────────────────────────────────────────────────────────────
function enumerateProjectDirs(): string[] {
  const wts = listWorktrees(projectPath);
  knownWorktrees = wts.map((w) => w.path);
  const dirs = new Set<string>();
  for (const w of knownWorktrees) {
    const d = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(w));
    if (existsSync(d)) dirs.add(d);
  }
  return [...dirs];
}

async function backfill(): Promise<void> {
  const dirs = enumerateProjectDirs();
  log(`backfill: ${dirs.length} in-project session dir(s)`);
  const batch: SessionDoc[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const inProject = ingestSessionFile(path);
      if (inProject === true) {
        const acc = accs.get(sessionIdFromPath(path));
        if (acc) batch.push(snapshot(acc, true));
      }
    }
  }
  checkpoints.flush();
  if (batch.length) await writer.upsertMany(projectId, batch);
  log(`backfill: ${batch.length} session(s) ingested`);

  // workflow state.yaml backfill — across the main repo AND every worktree
  scanAllStateYaml();
  await recomputeProject();
}

/** Workflow roots to scan: the main repo plus each worktree. Each worktree
 * carries its own committed copy of workflow/**, so a ticket's real progress
 * lives in ITS worktree, not the main checkout (which is often a stale stub). */
function workflowRoots(): string[] {
  const user = cfg.workflowUser ?? deriveWorkflowUser();
  const roots = new Set<string>([workflowDir(projectPath, user)]);
  for (const wt of knownWorktrees) roots.add(workflowDir(wt, user));
  return [...roots];
}

function scanAllStateYaml(): void {
  for (const root of workflowRoots()) scanStateYaml(root);
}

function deriveWorkflowUser(): string {
  // best-effort: first segment under workflow/ that exists
  const wfBase = join(projectPath, 'workflow');
  try {
    const subs = readdirSync(wfBase).filter((d) => {
      try {
        return statSync(join(wfBase, d)).isDirectory();
      } catch {
        return false;
      }
    });
    if (subs[0]) return subs[0];
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function scanStateYaml(root: string): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(p);
      else if (e === 'state.yaml') ingestStateYaml(p);
    }
  }
}

// ── watchers ────────────────────────────────────────────────────────────────
function startWatchers(): void {
  const usePoll = process.env.KS_FLOW_POLL === '1';
  const dirs = enumerateProjectDirs();

  // Watch the session DIRS (not a per-file glob) at depth 0 — one FSWatcher
  // per in-project dir. A watcher 'error' (e.g. EMFILE) is logged, never fatal.
  const sessionWatcher = chokidar.watch(dirs, {
    ignoreInitial: true,
    awaitWriteFinish: false,
    usePolling: usePoll,
    depth: 0,
  });
  const onSessionPath = (p: string) => {
    if (p.endsWith('.jsonl')) onSession(p);
  };
  sessionWatcher.on('add', onSessionPath);
  sessionWatcher.on('change', onSessionPath);
  sessionWatcher.on('unlink', (p) => {
    const cp = checkpoints.get(p);
    if (cp) writer.markArchived(projectId, cp.sessionId).catch(() => {});
  });
  sessionWatcher.on('error', (e) => log('session watcher error (continuing):', (e as Error)?.message));

  const eventsWatcher = chokidar.watch(EVENTS_PATH, {
    ignoreInitial: true,
    usePolling: usePoll,
  });
  eventsWatcher.on('add', ingestEvents);
  eventsWatcher.on('change', ingestEvents);
  eventsWatcher.on('error', (e) => log('events watcher error (continuing):', (e as Error)?.message));

  // state.yaml: a recursive chokidar `**` glob over the workflow tree opens an
  // FSWatcher per directory and blows the FD limit (EMFILE) on a big tree.
  // state.yaml changes are infrequent, so a periodic re-scan (idempotent) is
  // both cheaper and far more robust.
  setInterval(scanAllStateYaml, 15_000);

  // periodic worktree re-enumeration → add watches for new worktrees
  setInterval(() => {
    const fresh = enumerateProjectDirs();
    sessionWatcher.add(fresh);
  }, 60_000);

  log('watching', dirs.length, 'session dir(s) + events; rescanning workflow state.yaml every 15s');
}

function onSession(path: string): void {
  const inProject = ingestSessionFile(path);
  checkpoints.flush();
  const sessionId = sessionIdFromPath(path);
  if (inProject === true) scheduleSessionUpsert(sessionId);
}

// ── lifecycle ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  checkpoints.load();
  log(`project ${projectId} (${projectPath}) common-dir ${PROJECT_COMMON_DIR}`);
  log(`db_provider=${cfg.dbProvider} firestore_mode=${cfg.firestoreMode}`);
  // PocketBase is a local server we own — start it (and its migrations) and
  // wait for health BEFORE any write. Dry-run uses the in-memory provider, so
  // skip it there.
  if (cfg.dbProvider === 'pocketbase' && process.env.KS_FLOW_DRYRUN !== '1') {
    pbHandle = await startPocketbase(cfg.pocketbasePort, log);
  }
  ingestEvents(); // catch up overlay offset
  await backfill();
  // Backfill-only mode: ingest once, flush, exit (deterministic verification /
  // one-shot debug). No watchers, no live tailing.
  if (process.env.KS_FLOW_BACKFILL_ONLY === '1') {
    log('backfill-only: done, flushing and exiting');
    checkpoints.flush();
    if (writer.close) await writer.close();
    process.exit(0);
  }
  startWatchers();
  log('ready');
}

function shutdown(): void {
  checkpoints.flush();
  pbHandle?.stop();
  if (writer.close) writer.close().finally(() => process.exit(0));
  else process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((e) => {
  console.error('[ks-flow] fatal', e);
  process.exit(1);
});
