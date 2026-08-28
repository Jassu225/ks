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
//     --force               upload everything present, ignoring the local index
//     --reindex             upload nothing; rebuild archive-index.json from the
//                           bucket (recovery after a lost/cleared data dir)
//     --status              upload nothing; print per-unit backup status as JSON
//                           (what the board reads to decide whether to offer a
//                           Restore). Derived from the BUCKET, not the index.
//     --dry-run             print what would upload, touch nothing
//     --json                machine-readable result
//
// Invoked three ways: the daemon's end-of-day sweep, the board's manual
// "Back up now" / per-card backup buttons, and by hand for testing.
//
// Exit codes: 0 = done (or archiving disabled — a no-op, like the archive CLI);
// 1 = enabled but misconfigured, or an upload failed.
import { join } from 'node:path';
import { dataDir, readProjectConf } from './lib/config.js';
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
      default:
        break; // unknown flags ignored — this is called programmatically
    }
  }
  if (!Number.isFinite(a.sinceHours) || a.sinceHours < 0) a.sinceHours = 0;
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadEnvFile(join(dataDir(), '.env'));
  const settings = readArchiveSettings();
  if (!settings.enabled) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, disabled: true }) + '\n');
    else log('GCS archive disabled in settings — skipping.');
    process.exit(0);
  }

  const { config, missing } = resolveGcsConfig(settings);
  const blockers = [...missing];
  const zstdPath = resolveBinary('zstd');
  if (!zstdPath) blockers.push('zstd not installed (brew install zstd)');
  if (!resolveBinary('tar')) blockers.push('tar not found');
  if (!config || blockers.length > 0) {
    const msg = 'GCS archive is ENABLED but misconfigured:\n  - ' + blockers.join('\n  - ');
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else err(msg);
    process.exit(1);
  }

  const conf = readProjectConf();
  if (!conf?.projectPath) {
    const msg = 'no project.conf — run `ks-flow start` in the project first.';
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else err(msg);
    process.exit(1);
  }

  // Status mode: read-only, and deliberately bucket-derived — a unit archived
  // before this index existed (or on another machine) must still offer a Restore.
  if (args.status) {
    const units = await unitStatuses(conf.projectPath, config!);
    process.stdout.write(JSON.stringify({ ok: true, units }) + '\n');
    process.exit(0);
  }

  // Recovery mode: the index is a cache of what the bucket holds, and uploads
  // stamp each object with its source size/mtime (and the transcript dir it came
  // from), so the whole thing can be rebuilt from a listing. Uploads nothing.
  if (args.reindex) {
    const res = await reindexAll(conf.projectPath, config!, args.json ? () => {} : log);
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
    const msg = args.unit
      ? `no live worktree for unit ${args.unit} — nothing to back up.`
      : 'no targets to back up.';
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else err(msg);
    process.exit(1);
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
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: result.errorCount === 0, ...result }) + '\n');
  } else {
    const changed = result.units.filter((u) => u.uploaded.length > 0).length;
    const current = result.units.filter((u) => u.upToDate).length;
    if (result.uploadedCount === 0 && result.errorCount === 0) {
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
          `${current ? `, ${current} already current` : ''}` +
          `${result.errorCount ? `, ${result.errorCount} error(s)` : ''}.`,
      );
    }
  }
  process.exit(result.errorCount === 0 ? 0 : 1);
}

main().catch((e) => {
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
