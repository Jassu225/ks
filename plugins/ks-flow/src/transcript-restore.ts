#!/usr/bin/env node
// transcript-restore.ts — CLI: pull a unit's backed-up transcripts back to disk.
//
//   node dist/transcript-restore.js --unit <identifier> [--dry-run] [--json]
//                                  [--overwrite]
//
// The counterpart to transcript-backup.ts, invoked by the board's Restore
// button. LOCAL FILES WIN by default: only sessions missing from
// ~/.claude/projects/<encoded worktree> are written, because a transcript on
// disk is the live one Claude Code may still be appending to. `--overwrite`
// exists for the "my local copy is truncated" case and is never the default.
//
// Restores the CONVERSATION, not the worktree. If the worktree is gone, the
// encoded transcript path matches no live directory and `--resume` still won't
// list the session until that worktree exists again — the board says so.
import { join } from 'node:path';
import { dataDir, readProjectConf } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import { readArchiveSettings, resolveBinary, resolveGcsConfig } from './lib/archive-core.js';
import { discoverTargets, restoreUnit, type UnitTarget } from './lib/transcript-archive.js';
import { readArchiveIndex } from './lib/archive-index.js';
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
  // Fall back to the transcript dir recorded when the unit was last backed up:
  // that is the whole point of a restore for a worktree that has been removed.
  const conf = readProjectConf();
  let target: UnitTarget | undefined = conf?.projectPath
    ? discoverTargets(conf.projectPath).find((t) => t.identifier === unit)
    : undefined;
  if (!target) {
    const remembered = readArchiveIndex().units[unit];
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
    dryRun,
    log: json ? () => {} : log,
  });

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: res.errors.length === 0,
        transcriptDir: target!.transcriptDir,
        worktreeExists: Boolean(conf?.projectPath && target!.workflowDir !== undefined),
        ...res,
      }) + '\n',
    );
  } else {
    log(
      `${dryRun ? '[dry run] ' : ''}restored ${res.restored.length}, kept ${res.keptLocal.length} ` +
        `local${res.errors.length ? `, ${res.errors.length} error(s)` : ''} → ${target!.transcriptDir}`,
    );
    if (res.workflowObject) log(`workflow archive available: ${res.workflowObject}`);
  }
  process.exit(res.errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
