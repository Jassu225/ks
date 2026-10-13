#!/usr/bin/env node
// transcript-restore.ts — CLI: pull a unit's backed-up transcripts back to disk.
//
//   node dist/transcript-restore.js --unit <identifier> [--dry-run] [--json]
//                                  [--overwrite] [--workflow] [--overwrite-time-log]
//
// The counterpart to transcript-backup.ts, invoked by the board's Restore
// button. LOCAL FILES WIN by default: only sessions missing from
// ~/.claude/projects/<encoded worktree> are written, because a transcript on
// disk is the live one Claude Code may still be appending to. `--overwrite`
// exists for the "my local copy is truncated" case and is never the default.
//
// The time log is merged by default (cloud events the local log lacks are
// appended); `--overwrite-time-log` replaces the local log with the cloud copy —
// an escape hatch for a corrupted local log only, so the board does not offer it:
// backups upload the union of both logs, so replacing can only drop local events
// logged since the last backup.
// `--workflow` also unpacks workflow.tar.zst into the unit's workflow folder —
// the live worktree's, else the main checkout's — filling in missing files only
// unless `--overwrite`.
//
// Restores the CONVERSATION, not the worktree. If the worktree is gone, the
// encoded transcript path matches no live directory and `--resume` still won't
// list the session until that worktree exists again — the board says so.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadConfig, readProjectConf } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import { listObjects, readArchiveSettings, resolveBinary, resolveGcsConfig } from './lib/archive-core.js';
import {
  discoverCompletedTargets,
  discoverTargets,
  restoreUnit,
  unitPrefix,
  type UnitTarget,
} from './lib/transcript-archive.js';
import { loadArchiveIndex } from './lib/archive-index.js';
import { createProvider } from './lib/db/index.js';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir } from './lib/paths.js';

function log(m: string): void {
  process.stdout.write(`[ks-flow restore] ${m}\n`);
}
function err(m: string): void {
  process.stderr.write(`[ks-flow restore] ${m}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unit = argv[argv.indexOf('--unit') + 1];
  const dryRun = argv.includes('--dry-run');
  const overwrite = argv.includes('--overwrite');
  const overwriteTimeLog = argv.includes('--overwrite-time-log');
  const workflow = argv.includes('--workflow');
  const json = argv.includes('--json');
  const fail = (msg: string, code = 1): never => {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else err(msg);
    process.exit(code);
  };

  if (!unit || unit.startsWith('--')) fail('usage: transcript-restore --unit <identifier>', 2);

  loadEnvFile(join(dataDir(), '.env'));
  const settings = readArchiveSettings();
  if (!settings.enabled) fail('GCS archive is disabled in settings — nothing to restore from.');

  const { config, missing } = resolveGcsConfig(settings);
  const zstdPath = resolveBinary('zstd');
  if (!config) fail('GCS archive misconfigured: ' + missing.join('; '));
  if (!zstdPath) fail('zstd not installed (brew install zstd)');

  // Prefer a live worktree, so the restore lands where Claude Code will look.
  // Then the same fallbacks the board's status uses to decide a Restore is on
  // offer (unitStatuses): the completed-unit record in the main checkout's
  // workflow/ tree, the location stamped on the objects, then the backup index.
  // Resolving any narrower here would show a Restore button that then fails.
  const conf = readProjectConf();
  let target: UnitTarget | undefined = conf?.projectPath
    ? (discoverTargets(conf.projectPath).find((t) => t.identifier === unit) ??
      discoverCompletedTargets(conf.projectPath).find((t) => t.identifier === unit))
    : undefined;
  if (!target) {
    // Objects uploaded since stamping began carry their source location.
    const objects = await listObjects(config!, `${unitPrefix(config!, unit)}transcript/`).catch(() => []);
    const stamped = objects.find((o) => o.srcTranscriptDir || o.srcWorktree);
    if (stamped) {
      target = {
        identifier: unit,
        worktreePath: stamped.srcWorktree ?? '',
        transcriptDir:
          stamped.srcTranscriptDir ||
          join(CLAUDE_PROJECTS_DIR, encodeProjectDir(stamped.srcWorktree!)),
        workflowDir: null,
      };
    }
  }
  if (!target) {
    // The backup index (in the store) remembers where the unit's transcripts lived.
    const index = conf?.projectId
      ? await loadArchiveIndex(createProvider(loadConfig()).backups(), conf.projectId).catch(() => null)
      : null;
    const remembered = index?.units[unit];
    if (remembered) {
      target = {
        identifier: unit,
        worktreePath: remembered.worktreePath,
        transcriptDir:
          remembered.transcriptDir ||
          join(CLAUDE_PROJECTS_DIR, encodeProjectDir(remembered.worktreePath)),
        workflowDir: null,
      };
    }
  }
  if (!target) {
    fail(
      `no live worktree and no backup record for ${unit} — cannot tell where its ` +
        `transcripts belong. Recreate the worktree, then restore.`,
    );
  }

  const res = await restoreUnit({
    target: target!,
    gcs: config!,
    zstdPath: zstdPath!,
    overwrite,
    timeLog: overwriteTimeLog ? 'overwrite' : 'merge',
    workflow,
    projectPath: conf?.projectPath ?? null,
    dryRun,
    log: json ? () => {} : log,
  });

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: res.errors.length === 0,
        transcriptDir: target!.transcriptDir,
        worktreeExists: Boolean(target!.worktreePath) && existsSync(target!.worktreePath),
        ...res,
      }) + '\n',
    );
  } else {
    log(
      `${dryRun ? '[dry run] ' : ''}restored ${res.restored.length}, kept ${res.keptLocal.length} ` +
        `local${res.errors.length ? `, ${res.errors.length} error(s)` : ''} → ${target!.transcriptDir}`,
    );
    if (res.timeLog) {
      const tl = res.timeLog;
      log(
        tl.action === 'merged'
          ? `time log: merged ${tl.added} cloud-only event(s)`
          : tl.action === 'current'
            ? 'time log: already current'
            : `time log: ${tl.action}`,
      );
    }
    // A restored workflow already reported itself (restoreWorkflow logs its line).
    if (res.workflowObject && !workflow) {
      log(`workflow archive available (not restored — pass --workflow): ${res.workflowObject}`);
    }
  }
  process.exit(res.errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
