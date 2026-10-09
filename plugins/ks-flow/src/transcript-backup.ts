#!/usr/bin/env node
// transcript-backup.ts — CLI: back up changed session transcripts to GCS.
//
//   node dist/transcript-backup.js [options]
//
//   TARGET SELECTION (pick one; default = every live worktree of the project)
//     --unit <identifier>      one unit, by its Linear identifier
//     --worktree <path>        one worktree by path, live or about to be deleted
//                              (what the board's removal hook uses)
//     --identifier <id>        override the identifier for --worktree
//     --completed              units whose worktree is GONE — the old
//                              `backfill-archive` selection
//
//   OPTIONS
//     --unit <identifier>   only this unit (per-ticket backup)
//     --since-hours <n>     narrow the TRIGGER to units touched in the last n
//                           hours (default: no window). Never limits which files
//                           are uploaded — a triggered unit always has its whole
//                           worktree brought up to date.
//     --force               upload everything present, ignoring the backup index
//     --reindex             upload nothing; rebuild the store's backup index from
//                           the bucket (recovery after a lost/cleared store)
//     --status              upload nothing; print per-unit backup status as JSON
//                           (what the board reads to decide whether to offer a
//                           Restore). Derived from the BUCKET, not the index.
//     --dry-run             print what would upload, touch nothing
//     --json                machine-readable result
//     --trigger <t>         what started this run, for its history: daily (the
//                           daemon passes it), manual, unit, removal, completed.
//                           Left out, it follows the target flags.
//     --runs                upload nothing; print the run history as JSON (what
//                           the board's Backups page reads)
//
// Every real sweep is recorded in the store (PocketBase backup_runs; see
// lib/backup-runs.ts): when it started, what started it, and what it uploaded.
// The upload index lives there too (backup_units; see lib/archive-index.ts), so
// a sweep needs the store up — PocketBase runs with the daemon. Only a --force
// run (a worktree removal) goes ahead without it: it ignores the index anyway,
// and failing would block the worktree's deletion.
//
// Invoked three ways: the daemon's end-of-day sweep, the board's manual
// "Back up now" / per-card backup buttons, and by hand for testing.
//
// Exit codes: 0 = done (or archiving disabled — a no-op, like the archive CLI);
// 1 = enabled but misconfigured, or an upload failed.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, loadConfig, readProjectConf } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import {
  readArchiveSettings,
  resolveBinary,
  resolveGcsConfig,
} from './lib/archive-core.js';
import {
  discoverCompletedTargets,
  discoverTargets,
  reindexAll,
  sweep,
  unitStatuses,
  targetForWorktree,
  type UnitTarget,
} from './lib/transcript-archive.js';
import { expandTilde } from './lib/paths.js';
import { activeRun, lastSweepAt, listRuns } from './lib/backup-runs.js';
import { createProvider, type BackupRunDoc, type BackupStore, type BackupTrigger } from './lib/db/index.js';

function log(m: string): void {
  process.stdout.write(`[ks-flow backup] ${m}\n`);
}
function err(m: string): void {
  process.stderr.write(`[ks-flow backup] ${m}\n`);
}

interface Args {
  unit?: string;
  worktree?: string;
  identifier?: string;
  completed: boolean;
  reindex: boolean;
  status: boolean;
  sinceHours: number;
  all: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  trigger?: string;
  runs: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    completed: false,
    reindex: false,
    status: false,
    sinceHours: 0,
    all: false,
    force: false,
    dryRun: false,
    json: false,
    runs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--unit':
        a.unit = argv[++i];
        break;
      case '--worktree':
        a.worktree = argv[++i];
        break;
      case '--identifier':
        a.identifier = argv[++i];
        break;
      case '--completed':
        a.completed = true;
        break;
      case '--reindex':
        a.reindex = true;
        break;
      case '--status':
        a.status = true;
        break;
      case '--since-hours':
        a.sinceHours = Number(argv[++i]);
        break;
      case '--all':
        a.all = true;
        break;
      case '--force':
        a.force = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--trigger':
        a.trigger = argv[++i];
        break;
      case '--runs':
        a.runs = true;
        break;
      default:
        break; // unknown flags ignored — this is called programmatically
    }
  }
  if (!Number.isFinite(a.sinceHours) || a.sinceHours < 0) a.sinceHours = 0;
  return a;
}

const TRIGGERS: readonly BackupTrigger[] = ['daily', 'manual', 'unit', 'removal', 'completed'];

/** The run being recorded, once a real sweep has begun; a crash closes it as failed. */
let run: { store: BackupStore; projectId: string; doc: BackupRunDoc } | null = null;

function triggerOf(args: Args): BackupTrigger {
  if (args.trigger && (TRIGGERS as readonly string[]).includes(args.trigger)) return args.trigger as BackupTrigger;
  if (args.worktree) return 'removal';
  if (args.completed) return 'completed';
  return args.unit ? 'unit' : 'manual';
}

function scopeOf(args: Args): string {
  if (args.worktree) return args.identifier ? `${args.identifier} (${args.worktree})` : args.worktree;
  if (args.completed) return 'completed units';
  return args.unit ?? 'all live worktrees';
}

/** Writes the run's doc; history is a convenience, so a failed write never fails the backup. */
async function saveRun(): Promise<void> {
  if (!run) return;
  await run.store.upsertBackupRun(run.projectId, run.doc).catch((e: Error) => err(`could not record this run — ${e.message}`));
}

/** Closes the recorded run with its end fields. */
async function endRun(end: Omit<BackupRunDoc, 'uid' | 'startedAt' | 'trigger' | 'scope' | 'pid'>): Promise<void> {
  if (!run) return;
  run.doc = { ...run.doc, ...end };
  await saveRun();
  run = null;
}

/** Closes the recorded run as failed: it could not do its job at all. */
async function recordFailure(error: string): Promise<void> {
  await endRun({
    endedAt: new Date().toISOString(),
    outcome: 'failed',
    error,
    unitsChecked: 0,
    unitsCurrent: 0,
    uploadedCount: 0,
    errorCount: 0,
    units: [],
  });
}

/** Ends the process on a blocker, after closing the recorded run. */
async function fail(args: Args, msg: string): Promise<never> {
  await recordFailure(msg);
  if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else err(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadEnvFile(join(dataDir(), '.env'));
  const conf = readProjectConf();
  const projectId = conf?.projectId ?? '';
  const store = createProvider(loadConfig()).backups();

  // History mode: read-only, so it answers whatever the archive settings say.
  if (args.runs) {
    if (!conf) return fail(args, 'no project.conf — run `ks-flow start` in the project first.');
    const runs = await listRuns(store, projectId).catch((e: Error) => e);
    if (runs instanceof Error) return fail(args, `could not read the backup history: the ks-flow store (PocketBase) is not reachable — is the daemon running? (${runs.message})`);
    process.stdout.write(JSON.stringify({ ok: true, runs, lastSweepAt: lastSweepAt(runs) }) + '\n');
    process.exit(0);
  }

  const settings = readArchiveSettings();
  if (!settings.enabled) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, disabled: true }) + '\n');
    else log('GCS archive disabled in settings — skipping.');
    process.exit(0);
  }

  // The store holds the upload index: without it a sweep cannot tell what is
  // already in the bucket and would re-upload every unit. Status only reads it
  // for extras; a --force run ignores it.
  const isStoreUp = conf ? await store.getBackupRuns(projectId).then(() => true, () => false) : false;
  const isSweep = !args.status && !args.reindex;
  if (!isStoreUp && conf && (args.reindex || (isSweep && !args.force))) {
    return fail(args, 'the ks-flow store (PocketBase) is not reachable, and it holds the backup index — is the daemon running? `ks-flow start`');
  }
  if (!isStoreUp && isSweep) log('WARNING: the ks-flow store is not reachable — this run is not recorded and the index is not updated.');

  // One sweep at a time: two at once upload the same files twice and race on
  // the index. The daily one simply waits for tomorrow's check; a removal goes
  // ahead regardless (failing it would block the worktree's deletion).
  if (isSweep && !args.dryRun && isStoreUp) {
    const busy = activeRun(await listRuns(store, projectId).catch(() => []));
    if (busy && !args.worktree) {
      const since = new Date(busy.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const msg = `a backup is already running (${busy.trigger}, started ${since}) — try again when it finishes.`;
      if (triggerOf(args) === 'daily') {
        log(`${msg} Skipping.`);
        process.exit(0);
      }
      return fail(args, msg);
    }
  }

  // A real sweep from here on (status, reindex and dry runs upload nothing):
  // record it now, so even one that fails on a blocker or dies mid-run shows up.
  if (isSweep && !args.dryRun && isStoreUp) {
    run = {
      store,
      projectId,
      doc: { uid: randomUUID(), startedAt: new Date().toISOString(), trigger: triggerOf(args), scope: scopeOf(args), pid: process.pid },
    };
    await saveRun();
    // The board links its live log to the run's /backups row by this line.
    if (!args.json) log(`run ${run.doc.uid} started`);
  }

  const { config, missing } = resolveGcsConfig(settings);
  const blockers = [...missing];
  const zstdPath = resolveBinary('zstd');
  if (!zstdPath) blockers.push('zstd not installed (brew install zstd)');
  if (!resolveBinary('tar')) blockers.push('tar not found');
  if (!config || blockers.length > 0) {
    return fail(args, 'GCS archive is ENABLED but misconfigured:\n  - ' + blockers.join('\n  - '));
  }

  if (!conf?.projectPath) return fail(args, 'no project.conf — run `ks-flow start` in the project first.');

  // Status mode: read-only, and deliberately bucket-derived — a unit archived
  // before this index existed (or on another machine) must still offer a Restore.
  if (args.status) {
    const units = await unitStatuses(conf.projectPath, config, isStoreUp ? store : null, projectId);
    const swept = isStoreUp ? lastSweepAt(await store.getBackupRuns(projectId).catch(() => [])) : null;
    process.stdout.write(JSON.stringify({ ok: true, units, lastSweepAt: swept }) + '\n');
    process.exit(0);
  }

  // Recovery mode: the index is a cache of what the bucket holds, and uploads
  // stamp each object with its source size/mtime (and the transcript dir it came
  // from), so the whole thing can be rebuilt from a listing. Uploads nothing.
  if (args.reindex) {
    const res = await reindexAll(conf.projectPath, config, args.json ? () => {} : log, store, projectId);
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, ...res }) + '\n');
    else log(`reindexed ${res.recovered} unit(s)${res.skipped ? `, skipped ${res.skipped}` : ''}.`);
    process.exit(0);
  }

  // One uploader, several ways to choose what it operates on.
  let targets: UnitTarget[];
  if (args.worktree) {
    // A single worktree by path. The removal hook needs this: the worktree is
    // about to be deleted, and it may not be in `git worktree list` order or
    // resolvable from the project root by then.
    targets = [targetForWorktree(expandTilde(args.worktree), args.identifier)];
  } else if (args.completed) {
    targets = discoverCompletedTargets(conf.projectPath);
  } else {
    targets = discoverTargets(conf.projectPath);
    if (args.unit) targets = targets.filter((t) => t.identifier === args.unit);
  }
  if (targets.length === 0) {
    return fail(args, args.unit ? `no live worktree for unit ${args.unit} — nothing to back up.` : 'no targets to back up.');
  }

  // sinceHours 0 means NO window — not "since now", which is what a naive
  // Date.now() - 0 computes and which silently triggered nothing at all.
  const noWindow = args.all || args.force || args.sinceHours === 0;
  const sinceMs = noWindow ? 0 : Date.now() - args.sinceHours * 3_600_000;
  const result = await sweep({
    targets,
    gcs: config,
    zstdPath: zstdPath!,
    sinceMs,
    force: args.force,
    dryRun: args.dryRun,
    log: args.json ? () => {} : log,
    store: isStoreUp ? store : null,
    projectId,
  });

  if (run) {
    const touched = result.units.filter((u) => u.uploads.length > 0 || u.errors.length > 0);
    const files = touched.flatMap((u) => u.uploads);
    const uploads = files.length;
    await endRun({
      endedAt: new Date().toISOString(),
      // Errors with nothing uploaded (offline, credentials) is a run that did not happen.
      outcome: result.errorCount === 0 ? 'ok' : uploads > 0 ? 'partial' : 'failed',
      unitsChecked: result.units.length,
      // Current = nothing to upload and nothing failed, so checked = current + touched.
      unitsCurrent: result.units.length - touched.length,
      uploadedCount: uploads,
      errorCount: result.errorCount,
      bytesSource: files.reduce((n, f) => n + f.size, 0),
      bytesUploaded: files.reduce((n, f) => n + (f.compressedSize ?? 0), 0),
      units: touched.map((u) => ({ identifier: u.identifier, uploads: u.uploads, errors: u.errors })),
    });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: result.errorCount === 0, ...result }) + '\n');
  } else {
    const changed = result.units.filter((u) => u.uploaded.length > 0).length;
    const current = result.units.filter((u) => u.upToDate).length;
    const timeLogs = result.units.filter((u) => u.timeLog).length;
    const timeLogNote = timeLogs ? `, ${timeLogs} time log(s)` : '';
    if (result.uploadedCount === 0 && timeLogs === 0 && result.errorCount === 0) {
      // The common, healthy outcome for a unit that was already swept. Report it
      // as success with evidence, not as a bare zero.
      const backed = result.units.reduce((n, u) => n + u.localSessions, 0);
      log(
        `${result.dryRun ? '[dry run] ' : ''}nothing to upload — already up to date ` +
          `(${current} unit(s) current, ${backed} session file(s) accounted for).`,
      );
    } else {
      log(
        `${result.dryRun ? '[dry run] ' : ''}${result.uploadedCount} file(s) across ${changed} unit(s)` +
          timeLogNote +
          `${current ? `, ${current} already current` : ''}` +
          `${result.errorCount ? `, ${result.errorCount} error(s)` : ''}.`,
      );
    }
  }
  process.exit(result.errorCount === 0 ? 0 : 1);
}

main().catch(async (e) => {
  await recordFailure(`crashed: ${e?.message ?? e}`);
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
