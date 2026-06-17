#!/usr/bin/env node
// archive.ts — CLI: archive ONE worktree's conversation + workflow to GCS.
//
//   node dist/archive.js <worktreePath> [identifier] [title]
//
// Invoked by the board's worktree-removal hook (web /api/run-command) BEFORE
// the remove command runs, and by `ks-flow archive` for manual pushes. Exit
// codes drive the caller: 0 = archived OR disabled (no-op); non-zero = enabled
// but misconfigured / nothing to archive — the remove hook aborts on non-zero.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dataDir } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir, expandTilde } from './lib/paths.js';
import {
  archiveUnit,
  readArchiveSettings,
  resolveBinary,
  resolveGcsConfig,
} from './lib/archive-core.js';

function log(m: string): void {
  process.stdout.write(`[ks-flow archive] ${m}\n`);
}
function err(m: string): void {
  process.stderr.write(`[ks-flow archive] ${m}\n`);
}

async function main(): Promise<void> {
  const [worktreeArg, identifierArg] = process.argv.slice(2);
  if (!worktreeArg) {
    err('usage: archive <worktreePath> [identifier] [title]');
    process.exit(2);
  }

  loadEnvFile(join(dataDir(), '.env'));
  const settings = readArchiveSettings();
  if (!settings.enabled) {
    log('GCS archive disabled in settings — skipping.');
    process.exit(0);
  }

  const { config, missing } = resolveGcsConfig(settings);
  const blockers = [...missing];
  const zstdPath = resolveBinary('zstd');
  if (!zstdPath) blockers.push('zstd not installed (brew install zstd)');
  if (!resolveBinary('tar')) blockers.push('tar not found');
  if (!config || blockers.length > 0) {
    err('GCS archive is ENABLED but misconfigured — aborting:\n  - ' + blockers.join('\n  - '));
    process.exit(1);
  }

  const wt = expandTilde(worktreeArg);
  const identifier = (identifierArg || '').trim() || basename(wt);

  const transcriptDir = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(wt));
  const workflowDir = join(wt, 'workflow');
  const tDir = existsSync(transcriptDir) ? transcriptDir : null;
  const wDir = existsSync(workflowDir) ? workflowDir : null;
  if (!tDir) err(`no transcript dir at ${transcriptDir} — archiving workflow only.`);
  if (!wDir) err(`no workflow dir at ${workflowDir} — archiving transcript only.`);

  const safeId = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  const objectPrefix = [config.prefix, safeId].filter(Boolean).join('/') + '/';
  const dedupPrefix = objectPrefix;

  // Explicit removal always archives (one-shot) — force past the dedup check.
  const res = await archiveUnit({
    transcriptDir: tDir,
    workflowDir: wDir,
    objectPrefix,
    dedupPrefix,
    gcs: config,
    zstdPath: zstdPath!,
    force: true,
    log,
  });
  if (res.status === 'nothing') {
    err('nothing to archive — neither transcript nor workflow dir exists.');
    process.exit(1);
  }
  for (const o of res.objects) log(`uploaded ${o}`);
  log('done.');
}

main().catch((e) => {
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
