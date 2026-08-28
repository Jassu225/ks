#!/usr/bin/env node
// migrate-legacy-archives.ts — convert whole-directory archives to per-file objects.
//
//   node dist/migrate-legacy-archives.js [options]
//     --unit <id>          migrate just this unit
//     --dry-run            report the plan, touch nothing
//     --backup-prefix <p>  where the safety copy goes (default: _legacy-backup/<ISO date>)
//     --skip-backup        DON'T copy first (not recommended; see below)
//     --delete-legacy      remove the original transcript.tar.zst after a verified
//                          conversion. Off by default — restore can still read it.
//     --force              re-convert a unit that already has per-file objects
//     --json               machine-readable summary
//
// WHY
// Units archived by the old worktree-removal hook hold one
// `<id>/transcript.tar.zst` — a tarball of the whole transcript directory. The
// board's Restore reads per-file objects, and per-file is what makes local
// 30-day pruning unable to clobber an older session (see lib/transcript-archive.ts).
// Restore falls back to reading a legacy tarball, so nothing is broken today, but
// those units cannot be incrementally updated: any future backup of them
// re-uploads from scratch, and they carry no manifest or source stamps.
//
// SAFETY
// Every object under a unit's prefix is server-side copied to the backup prefix
// BEFORE anything is written or removed — no download, no egress, and the
// original bytes remain addressable even if a conversion goes wrong midway.
// Conversion itself only ADDS objects (the tarball is left alone unless
// --delete-legacy), so the failure mode is a partially converted unit, which a
// re-run finishes.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, readProjectConf } from './lib/config.js';
import { loadEnvFile } from './lib/envfile.js';
import {
  copyObject,
  deleteObject,
  listObjects,
  readArchiveSettings,
  resolveBinary,
  resolveGcsConfig,
  uploadFile,
  uploadJson,
  type GcsConfig,
} from './lib/archive-core.js';
import {
  MANIFEST_NAME,
  bucketUnits,
  compressAndStamp,
  discoverCompletedTargets,
  discoverTargets,
  extractLegacyTarball,
  sessionFiles,
  unitPrefix,
  type UnitTarget,
} from './lib/transcript-archive.js';
import { readArchiveIndex, writeArchiveIndex, type ArchivedSession, type UnitArchive } from './lib/archive-index.js';

function log(m: string): void {
  process.stdout.write(`[ks-flow migrate] ${m}\n`);
}
function err(m: string): void {
  process.stderr.write(`[ks-flow migrate] ${m}\n`);
}

interface Args {
  unit?: string;
  dryRun: boolean;
  backupPrefix: string;
  skipBackup: boolean;
  deleteLegacy: boolean;
  force: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    backupPrefix: `_legacy-backup/${new Date().toISOString().slice(0, 19).replace(/[:]/g, '-')}`,
    skipBackup: false,
    deleteLegacy: false,
    force: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--unit':
        a.unit = argv[++i];
        break;
      case '--backup-prefix':
        a.backupPrefix = (argv[++i] ?? '').replace(/\/+$/, '');
        break;
      case '--skip-backup':
        a.skipBackup = true;
        break;
      case '--delete-legacy':
        a.deleteLegacy = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--force':
        a.force = true;
        break;
      case '--json':
        a.json = true;
        break;
      default:
        break;
    }
  }
  return a;
}

interface UnitPlan {
  identifier: string;
  legacyObject: string;
  objects: string[]; // everything under the unit prefix, for the safety copy
  hasPerFile: boolean;
}

interface UnitOutcome {
  identifier: string;
  copied: number;
  converted: number;
  deletedLegacy: boolean;
  skipped?: string;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadEnvFile(join(dataDir(), '.env'));
  const settings = readArchiveSettings();
  if (!settings.enabled) {
    err('GCS archive is disabled in settings — nothing to migrate.');
    process.exit(1);
  }
  const { config, missing } = resolveGcsConfig(settings);
  const zstdPath = resolveBinary('zstd');
  if (!config) {
    err('GCS archive misconfigured: ' + missing.join('; '));
    process.exit(1);
  }
  if (!zstdPath) {
    err('zstd not installed (brew install zstd)');
    process.exit(1);
  }

  // Where each unit's transcripts belong, for the stamps and the manifest.
  const conf = readProjectConf();
  const known = new Map<string, UnitTarget>();
  if (conf?.projectPath) {
    for (const t of discoverCompletedTargets(conf.projectPath)) known.set(t.identifier, t);
    for (const t of discoverTargets(conf.projectPath)) known.set(t.identifier, t);
  }

  // ── plan ──────────────────────────────────────────────────────────────────
  const ids = args.unit ? [args.unit] : await bucketUnits(config);
  const plans: UnitPlan[] = [];
  for (const id of ids) {
    if (id.startsWith('_legacy-backup')) continue; // never migrate a safety copy
    const prefix = unitPrefix(config, id);
    const objects = (await listObjects(config, prefix)).map((o) => o.name);
    const legacyObject = `${prefix}transcript.tar.zst`;
    if (!objects.includes(legacyObject)) continue; // already new-format or empty
    plans.push({
      identifier: id,
      legacyObject,
      objects,
      hasPerFile: objects.some((n) => n.startsWith(`${prefix}transcript/`)),
    });
  }

  if (plans.length === 0) {
    const msg = 'no legacy archives found — nothing to migrate.';
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, units: [] }) + '\n');
    else log(msg);
    process.exit(0);
  }

  log(
    `${plans.length} unit(s) with a legacy transcript.tar.zst` +
      `${args.dryRun ? ' — DRY RUN, nothing will be written' : ''}`,
  );
  if (!args.skipBackup) log(`safety copy → gs://${config.bucket}/${args.backupPrefix}/<unit>/…`);

  // ── run ───────────────────────────────────────────────────────────────────
  const index = readArchiveIndex();
  const outcomes: UnitOutcome[] = [];

  for (const plan of plans) {
    const out: UnitOutcome = {
      identifier: plan.identifier,
      copied: 0,
      converted: 0,
      deletedLegacy: false,
    };

    if (plan.hasPerFile && !args.force) {
      out.skipped = 'already has per-file objects (use --force to redo)';
      log(`${plan.identifier}: ${out.skipped}`);
      outcomes.push(out);
      continue;
    }

    try {
      // 1) Safety copy FIRST — always, before a single write.
      if (!args.skipBackup) {
        for (const name of plan.objects) {
          const dest = `${args.backupPrefix}/${name}`;
          if (args.dryRun) {
            out.copied++;
            continue;
          }
          await copyObject(config, name, dest);
          out.copied++;
        }
        log(`${plan.identifier}: copied ${out.copied} object(s) to the safety prefix`);
      }

      // 2) Convert: unpack the tarball, upload each session file on its own.
      //
      // A dry run stops here on purpose. Counting the sessions inside would mean
      // downloading and unpacking every tarball — 35 of them on the first real
      // bucket, which turned a "tell me the plan" command into minutes of
      // transfer. The plan does not need the contents.
      if (args.dryRun) {
        log(`${plan.identifier}: would convert ${plan.legacyObject} (contents not inspected)`);
        outcomes.push(out);
        continue;
      }

      const workDir = mkdtempSync(join(tmpdir(), 'ksflow-migrate-'));
      const sessions: Record<string, ArchivedSession> = {};
      try {
        const src = await extractLegacyTarball(config, plan.legacyObject, zstdPath, workDir);
        const rels = sessionFiles(src);
        log(`${plan.identifier}: ${rels.length} session file(s) in the tarball`);
        const target = known.get(plan.identifier);
        const prefix = unitPrefix(config, plan.identifier);

        for (const rel of rels) {
          const abs = join(src, rel);
          const st = statSync(abs);
          const object = `${prefix}transcript/${rel}.zst`;
          // tar preserved the original mtime, so the stamp matches what a local
          // sweep would compute — the converted object is then indistinguishable
          // from one uploaded normally, and will not needlessly re-upload.
          const record = await compressAndStamp({
            gcs: config,
            zstdPath,
            file: abs,
            object,
            size: st.size,
            mtimeMs: st.mtimeMs,
            worktreePath: target?.worktreePath,
            transcriptDir: target?.transcriptDir,
          });
          sessions[rel] = record;
          out.converted++;
        }

        // 3) Manifest, so the unit is self-describing like any swept unit.
        {
          const workflowObject = plan.objects.includes(`${prefix}workflow.tar.zst`)
            ? `gs://${config.bucket}/${prefix}workflow.tar.zst`
            : null;
          const unit: UnitArchive = {
            identifier: plan.identifier,
            worktreePath: target?.worktreePath ?? '',
            transcriptDir: target?.transcriptDir ?? '',
            sessions,
            workflow: workflowObject
              ? { object: workflowObject, size: 0, uploadedAt: new Date().toISOString() }
              : null,
            lastArchivedAt: new Date().toISOString(),
          };
          if (!unit.transcriptDir) {
            err(
              `${plan.identifier}: no live worktree and no completed-unit record — ` +
                `manifest written without a transcript dir, so a restore will need one.`,
            );
          }
          await uploadJson(config, `${prefix}${MANIFEST_NAME}`, unit);
          index.units[plan.identifier] = unit;
          // The local index is a cache; the bucket already has the data and the
          // manifest. Failing the unit over an unwritable cache would report a
          // successful conversion as a failure (and it did, on a read-only data
          // dir) — and a re-run would then redo every upload.
          try {
            writeArchiveIndex(index);
          } catch (e) {
            err(`${plan.identifier}: converted, but could not update the local index — ${(e as Error).message}`);
          }
        }

        // 4) Only now is dropping the original defensible.
        if (args.deleteLegacy) {
          await deleteObject(config, plan.legacyObject);
          out.deletedLegacy = true;
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }

      log(
        `${plan.identifier}: converted ${out.converted} session file(s)` +
          `${out.deletedLegacy ? ', legacy tarball deleted' : ''}`,
      );
    } catch (e) {
      out.error = (e as Error)?.message ?? String(e);
      err(`${plan.identifier}: FAILED — ${out.error}`);
    }
    outcomes.push(out);
  }

  const failed = outcomes.filter((o) => o.error).length;
  // In a dry run nothing is converted, so report what WOULD be — a bare "0
  // unit(s) converted" after listing 35 candidates reads like a failure.
  const done = args.dryRun
    ? outcomes.filter((o) => !o.skipped && !o.error).length
    : outcomes.filter((o) => o.converted > 0).length;
  const skipped = outcomes.filter((o) => o.skipped).length;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: failed === 0, dryRun: args.dryRun, outcomes }) + '\n');
  } else {
    log(
      `${args.dryRun ? '[dry run] would convert ' : ''}${done} unit(s)` +
        `${args.dryRun ? '' : ' converted'}` +
        `${skipped ? `, ${skipped} already new-format` : ''}` +
        `${failed ? `, ${failed} failed` : ''}.`,
    );
    if (!args.skipBackup && !args.dryRun) {
      log(`safety copies remain at gs://${config.bucket}/${args.backupPrefix}/ — delete when satisfied.`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  err(`failed: ${e?.message ?? e}`);
  process.exit(1);
});
