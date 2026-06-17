#!/usr/bin/env node
// backfill-archive.ts — one-shot: archive already-completed workflows to GCS.
//
//   node dist/backfill-archive.js [--dry-run] [--force]
//
// "Completed" = a workflow whose state.yaml lives in the MAIN checkout's
// workflow/ tree but whose recorded worktree_dir is no longer a live git
// worktree (it was removed on completion, so it never hit the live
// removal-hook archive). For each, we locate its transcript dir under
// ~/.claude/projects/ (persists after `git worktree remove`) and its workflow
// dir (the state.yaml's own folder), then archive both via archiveUnit.
//
//   --dry-run  list candidates + resolved dirs, upload nothing (no creds needed)
//   --force    re-upload even if objects already exist for the unit
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, readProjectConf } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir } from './lib/paths.js';
import { parseStateYaml } from './lib/stateyaml.js';
import { listWorktrees } from './lib/worktree.js';
import {
  archiveUnit,
  readArchiveSettings,
  resolveBinary,
  resolveGcsConfig,
  type GcsConfig,
} from './lib/archive-core.js';

function log(m: string): void {
  process.stdout.write(`[ks-flow backfill] ${m}\n`);
}
function err(m: string): void {
  process.stderr.write(`[ks-flow backfill] ${m}\n`);
}
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Recursively collect every state.yaml path under `root`. */
function findStateYaml(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
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
      else if (e === 'state.yaml') out.push(p);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  loadEnvFile(join(dataDir(), '.env'));
  const settings = readArchiveSettings();
  if (!settings.enabled) {
    err('GCS archive is disabled — enable it in Settings (and set bucket + creds) first.');
    process.exit(1);
  }

  // Dry-run only previews, so it needs neither creds nor zstd.
  let config: GcsConfig | null = null;
  let zstdPath = '';
  if (!dryRun) {
    const r = resolveGcsConfig(settings);
    const blockers = [...r.missing];
    const z = resolveBinary('zstd');
    if (!z) blockers.push('zstd not installed (brew install zstd)');
    if (!resolveBinary('tar')) blockers.push('tar not found');
    if (!r.config || blockers.length > 0) {
      err('GCS archive is ENABLED but misconfigured — aborting:\n  - ' + blockers.join('\n  - '));
      process.exit(1);
    }
    config = r.config;
    zstdPath = z!;
  }

  const conf = readProjectConf();
  if (!conf) {
    err('no project.conf — run `ks-flow set-project <path>` first.');
    process.exit(1);
  }
  const root = join(conf.projectPath, 'workflow');
  const live = new Set(listWorktrees(conf.projectPath).map((w) => w.path)); // realpath'd

  const files = findStateYaml(root);
  log(`scanning ${root} — ${files.length} state.yaml found; ${live.size} live worktree(s).`);

  const tally = {
    archived: 0,
    skippedLive: 0,
    skippedExisting: 0,
    workflowOnly: 0,
    nothing: 0,
    failed: 0,
  };

  for (const file of files) {
    const parsed = parseStateYaml(file);
    if (!parsed) {
      err(`skip — could not parse ${file}`);
      tally.failed++;
      continue;
    }
    const { identifier, worktreeDir } = parsed.doc; // worktreeDir is expandTilde'd or null

    // In progress → the live removal hook will archive it; skip here.
    if (worktreeDir && live.has(realpathOr(worktreeDir))) {
      tally.skippedLive++;
      continue;
    }

    const workflowUnitDir = dirname(file);
    let transcriptDir: string | null = null;
    if (worktreeDir) {
      const enc = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(worktreeDir));
      try {
        statSync(enc);
        transcriptDir = enc;
      } catch {
        // transcript dir gone / never existed for this worktree
      }
    }
    if (!transcriptDir) {
      err(`${identifier}: no transcript dir (worktree_dir=${worktreeDir ?? 'none'}) — workflow only.`);
      tally.workflowOnly++;
    }

    const safeId = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
    const dedupPrefix = [config?.prefix, safeId].filter(Boolean).join('/') + '/';

    if (dryRun) {
      log(
        `would archive ${identifier}\n` +
          `    transcript: ${transcriptDir ?? '(none)'}\n` +
          `    workflow:   ${workflowUnitDir}`,
      );
      continue;
    }

    const objectPrefix = [config!.prefix, safeId].filter(Boolean).join('/') + '/';
    try {
      const res = await archiveUnit({
        transcriptDir,
        workflowDir: workflowUnitDir,
        objectPrefix,
        dedupPrefix,
        gcs: config!,
        zstdPath,
        force,
        log: (m) => log(`${identifier}: ${m}`),
      });
      if (res.status === 'uploaded') tally.archived++;
      else if (res.status === 'skipped-existing') tally.skippedExisting++;
      else tally.nothing++;
    } catch (e) {
      err(`${identifier}: failed — ${(e as Error)?.message ?? e}`);
      tally.failed++;
    }
  }

  log(
    `${dryRun ? '[dry-run] ' : ''}done — ` +
      `archived=${tally.archived} skipped-live=${tally.skippedLive} ` +
      `skipped-existing=${tally.skippedExisting} workflow-only=${tally.workflowOnly} ` +
      `nothing=${tally.nothing} failed=${tally.failed}`,
  );
  if (tally.failed > 0) process.exit(1);
}

main().catch((e) => {
  err(`fatal: ${e?.message ?? e}`);
  process.exit(1);
});
