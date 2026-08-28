// lib/transcript-archive.ts — the daily transcript backup sweep, and restore.
//
// WHY THIS EXISTS
// Claude Code prunes ~/.claude/projects/**/*.jsonl at 30 days (verified: on this
// machine the oldest surviving JSONL was exactly 30 days old, with none older).
// A session you leave and come back to after a month has therefore lost its
// transcript — `--resume` finds nothing. Until now the ONLY thing that pushed a
// transcript to GCS was the board's Remove button, i.e. the one case where you
// were finished with the work anyway. This sweep covers the opposite case.
//
// WHAT IT UPLOADS
// One object per session JSONL, keyed by its path relative to the transcript
// dir, NOT a tarball of the directory:
//
//   <prefix>/<identifier>/transcript/<sessionId>.jsonl.zst
//   <prefix>/<identifier>/transcript/subagents/<id>.jsonl.zst
//
// A directory tarball would be actively dangerous here. Once local pruning has
// removed an old session, re-tarring the directory uploads a tree that has LOST
// that file, overwriting a good cloud copy with a lesser one — silently, and
// exactly for the long-lived units this feature is meant to protect. Per-file
// objects make that impossible: pruning locally never deletes from the bucket.
//
// TRIGGER vs ACTION — these are deliberately different
// TRIGGER: a session file whose size or mtime differs from the local index (see
// archive-index.ts). That is the only trigger; a lone state.yaml touch does
// nothing, because workflow/ is committed to git and already recoverable.
//
// ACTION: back up the WHOLE worktree — every session file not already in the
// bucket, plus a refreshed workflow.tar.zst. Not just the file that changed.
//
// Getting this wrong loses data, and did: with the action scoped to files
// modified inside the window, KAR-12770 had 17 local sessions and exactly ONE in
// the bucket. The other 16 were older than the window, so they were skipped —
// and they would never be uploaded, because a finished session never changes
// again. They would simply reach 30 days and be pruned. A session update now
// sweeps up everything that unit has, so resuming an old session finds it.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  buildTarZst,
  compressFile,
  decompressFile,
  downloadJson,
  downloadObject,
  listObjects,
  uploadFile,
  uploadJson,
  type GcsConfig,
} from './archive-core.js';
import {
  needsUpload,
  readArchiveIndex,
  writeArchiveIndex,
  type ArchiveIndex,
  type ArchivedSession,
  type UnitArchive,
} from './archive-index.js';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir } from './paths.js';
import { parseStateYaml } from './stateyaml.js';
import { listWorktrees } from './worktree.js';

/** A unit the sweep can act on: one git worktree of the tracked project. */
export interface UnitTarget {
  identifier: string;
  worktreePath: string;
  transcriptDir: string; // ~/.claude/projects/<encoded worktree path>
  workflowDir: string | null; // <worktree>/workflow, when present
}

/** Object-name-safe identifier — mirrors the removal path's rule so both write
 * under the same per-unit prefix. */
/** Per-unit manifest object name, written next to the unit's data. */
export const MANIFEST_NAME = 'manifest.json';

export function safeId(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function unitPrefix(gcs: GcsConfig, identifier: string): string {
  return [gcs.prefix, safeId(identifier)].filter(Boolean).join('/') + '/';
}

/**
 * Every worktree of the tracked project, as a sweep target.
 *
 * Scope is deliberately "reachable via a live worktree": a session whose
 * worktree is gone was removed through the board, which already archived it,
 * and its transcript can no longer grow. `git worktree list` is the authority —
 * project.conf's worktreePaths can lag.
 */
export function discoverTargets(projectPath: string): UnitTarget[] {
  const index = buildIdentityIndex(projectPath);
  const targets: UnitTarget[] = [];
  for (const wt of listWorktrees(projectPath)) {
    const found = index.get(realpathOr(wt.path)) ?? identityFromWorktree(wt.path);
    // Prefer the worktree's OWN copy of the unit's workflow dir — that is the
    // one being edited. But a worktree whose branch predates the commit that
    // added its workflow dir does not have that copy, and returning null there
    // meant the unit's workflow was never archived at all; fall back to the main
    // checkout's copy, which is better than nothing.
    const own = found ? join(wt.path, found.workflowRel) : null;
    const shared = found ? join(projectPath, found.workflowRel) : null;
    targets.push({
      identifier: found?.identifier ?? basename(wt.path),
      worktreePath: wt.path,
      transcriptDir: join(CLAUDE_PROJECTS_DIR, encodeProjectDir(wt.path)),
      workflowDir:
        own && existsSync(own) ? own : shared && existsSync(shared) ? shared : null,
    });
  }
  return targets;
}

/**
 * Units whose worktree is GONE — completed work that `discoverTargets` cannot
 * see because `git worktree list` no longer mentions it.
 *
 * Discovery runs off the main checkout's committed workflow tree: each
 * state.yaml records the `worktree_dir` it belonged to, and the transcript dir
 * survives under ~/.claude/projects/ after `git worktree remove`, so the
 * conversation is still recoverable even though the code checkout is not. Units
 * whose worktree is still live are skipped — they belong to discoverTargets.
 *
 * This is the old `backfill-archive` selection rule, kept as a target set rather
 * than a second uploader so everything funnels through one sweep().
 */
export function discoverCompletedTargets(projectPath: string): UnitTarget[] {
  const live = new Set(listWorktrees(projectPath).map((w) => realpathOr(w.path)));
  const targets: UnitTarget[] = [];
  for (const path of findStateYamls(join(projectPath, 'workflow'))) {
    const parsed = parseStateYaml(path);
    if (!parsed?.doc.identifier) continue;
    const { identifier, worktreeDir } = parsed.doc;
    if (!worktreeDir || live.has(realpathOr(worktreeDir))) continue;
    const transcriptDir = join(CLAUDE_PROJECTS_DIR, encodeProjectDir(worktreeDir));
    const workflowDir = dirname(path);
    // Nothing left on disk for either half → nothing this tool can archive.
    if (!existsSync(transcriptDir) && !existsSync(workflowDir)) continue;
    targets.push({
      identifier,
      worktreePath: worktreeDir,
      transcriptDir,
      workflowDir: existsSync(workflowDir) ? workflowDir : null,
    });
  }
  return targets;
}

/** A unit's identity, plus where its workflow dir sits relative to a worktree
 * root (`workflow/<user>/<slug>` or `workflow/<user>/tickets/<id>`). */
interface UnitIdentity {
  identifier: string;
  workflowRel: string;
}

/**
 * Map realpath(worktree_dir) → unit identity, built ONCE from the main
 * checkout's committed workflow tree.
 *
 * Two traps this navigates. First, `workflow/` is committed, so every worktree
 * carries every unit's state.yaml — the only file that identifies a given
 * worktree is the one whose own `worktree_dir` points back at it, never "the
 * first one on disk" (that bug made five unrelated worktrees share one object
 * prefix). Second, the tree is not one shape: project units sit at
 * `workflow/<user>/<slug>/` while tickets sit at
 * `workflow/<user>/tickets/<id>/`, so this walks instead of globbing a fixed
 * depth — the fixed-depth version silently matched nothing for every ticket.
 *
 * Taking the identifier from state.yaml also keeps the sweep aligned with the
 * removal path, which keys on the board card's identifier — the same value, so
 * both write under the same per-unit prefix.
 */
function buildIdentityIndex(projectPath: string): Map<string, UnitIdentity> {
  const index = new Map<string, UnitIdentity>();
  for (const path of findStateYamls(join(projectPath, 'workflow'))) {
    const parsed = parseStateYaml(path);
    if (!parsed?.doc.identifier || !parsed.doc.worktreeDir) continue;
    index.set(realpathOr(parsed.doc.worktreeDir), {
      identifier: parsed.doc.identifier,
      workflowRel: relative(projectPath, dirname(path)),
    });
  }
  return index;
}

/** Fallback for a unit whose state.yaml has not reached the main checkout yet:
 * walk the worktree's own workflow tree. Only runs for worktrees the index
 * missed, so the common case parses each state.yaml once per sweep. */
function identityFromWorktree(worktreePath: string): UnitIdentity | null {
  const self = realpathOr(worktreePath);
  for (const path of findStateYamls(join(worktreePath, 'workflow'))) {
    const parsed = parseStateYaml(path);
    if (!parsed?.doc.identifier || !parsed.doc.worktreeDir) continue;
    if (realpathOr(parsed.doc.worktreeDir) !== self) continue;
    return { identifier: parsed.doc.identifier, workflowRel: relative(worktreePath, dirname(path)) };
  }
  return null;
}

/** Every state.yaml under `root`, depth-capped so a stray deep tree can't turn
 * the sweep into a full-disk walk. */
function findStateYamls(root: string, maxDepth = 5): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const e of safeDirents(dir)) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name === 'state.yaml') out.push(join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // path may not exist (a stale worktree_dir) — compare as written
  }
}

/** Session JSONL paths under a transcript dir, relative to it (so
 * `subagents/x.jsonl` stays distinct from `x.jsonl`). */
export function sessionFiles(transcriptDir: string): string[] {
  const rels: string[] = [];
  for (const e of safeDirents(transcriptDir)) {
    if (e.isFile() && e.name.endsWith('.jsonl')) rels.push(e.name);
  }
  for (const e of safeDirents(join(transcriptDir, 'subagents'))) {
    if (e.isFile() && e.name.endsWith('.jsonl')) rels.push(join('subagents', e.name));
  }
  return rels;
}

function safeDirents(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A sweep target for one worktree, for callers that have a path in hand rather
 * than a project root — notably the removal hook, which runs against a worktree
 * that is about to be deleted.
 */
export function targetForWorktree(worktreePath: string, identifier?: string): UnitTarget {
  const found = identityFromWorktree(worktreePath);
  const own = found ? join(worktreePath, found.workflowRel) : null;
  const fallbackWorkflow = join(worktreePath, 'workflow');
  return {
    identifier: identifier?.trim() || found?.identifier || basename(worktreePath),
    worktreePath,
    transcriptDir: join(CLAUDE_PROJECTS_DIR, encodeProjectDir(worktreePath)),
    workflowDir:
      own && existsSync(own) ? own : existsSync(fallbackWorkflow) ? fallbackWorkflow : null,
  };
}

/** Compress one session file, upload it with its source stamp, and return the
 * index record for it. The single place a session object is written — the sweep
 * and the legacy migration both go through here, so stamps and object naming
 * cannot drift apart. */
export async function compressAndStamp(opts: {
  gcs: GcsConfig;
  zstdPath: string;
  file: string;
  object: string;
  size: number;
  mtimeMs: number;
  worktreePath?: string;
  transcriptDir?: string;
}): Promise<ArchivedSession> {
  const { gcs, zstdPath, file, object, size, mtimeMs, worktreePath, transcriptDir } = opts;
  const tmp = join(tmpdir(), `ksflow-obj-${process.pid}-${randomUUID()}.zst`);
  try {
    await compressFile(file, tmp, zstdPath);
    await uploadFile(gcs, tmp, object, {
      srcSize: size,
      srcMtimeMs: mtimeMs,
      srcWorktree: worktreePath,
      srcTranscriptDir: transcriptDir,
    });
    return {
      size,
      mtimeMs,
      object: `gs://${gcs.bucket}/${object}`,
      uploadedAt: new Date().toISOString(),
    };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
  }
}

export interface SweepOpts {
  targets: UnitTarget[];
  gcs: GcsConfig;
  zstdPath: string;
  /** Only consider session files modified at or after this epoch ms. */
  sinceMs: number;
  /** Ignore both the window and the index — re-upload everything present. */
  force?: boolean;
  dryRun?: boolean;
  log: (msg: string) => void;
}

export interface UnitSweepResult {
  identifier: string;
  uploaded: string[]; // rel paths
  skipped: number; // already in the bucket / outside the trigger window
  workflow: boolean;
  errors: string[];
  /** Nothing to do: no session file differs from what is already archived. */
  upToDate: boolean;
  /** Session files this unit has on disk, for an honest "N already backed up". */
  localSessions: number;
}

export interface SweepResult {
  units: UnitSweepResult[];
  uploadedCount: number;
  errorCount: number;
  dryRun: boolean;
}

/**
 * Upload every changed session file for each target, plus a refreshed
 * workflow.tar.zst for units that had one.
 *
 * The local index is written after EACH unit rather than once at the end, so an
 * interrupted sweep doesn't re-upload everything it already did.
 */
export async function sweep(opts: SweepOpts): Promise<SweepResult> {
  const { targets, gcs, zstdPath, sinceMs, force = false, dryRun = false, log } = opts;
  const index = readArchiveIndex();
  const results: UnitSweepResult[] = [];
  let uploadedCount = 0;
  let errorCount = 0;

  for (const t of targets) {
    const res: UnitSweepResult = {
      identifier: t.identifier,
      uploaded: [],
      skipped: 0,
      workflow: false,
      errors: [],
      upToDate: false,
      localSessions: 0,
    };
    const prev = index.units[t.identifier];
    const sessions: Record<string, ArchivedSession> = { ...(prev?.sessions ?? {}) };
    const prefix = unitPrefix(gcs, t.identifier);

    // Reconcile the index against the BUCKET before trusting it. The index is a
    // cache, and an object deleted in the cloud (console, lifecycle rule, a
    // colleague tidying up) leaves the cache claiming a backup that no longer
    // exists — the sweep then reports "nothing to upload" and the data stays
    // gone. One list call per unit makes deletion self-healing.
    let remote: Set<string>;
    try {
      remote = new Set((await listObjects(gcs, prefix)).map((o) => o.name));
    } catch (e) {
      // A listing failure must not stop the sweep; fall back to trusting the
      // index, which errs towards uploading less rather than losing data.
      log(`WARNING: could not list gs://${gcs.bucket}/${prefix} — ${(e as Error).message}`);
      remote = new Set(Object.values(sessions).map((v) => v.object.replace(`gs://${gcs.bucket}/`, '')));
    }
    let vanished = 0;
    for (const rel of Object.keys(sessions)) {
      if (!remote.has(`${prefix}transcript/${rel}.zst`)) {
        delete sessions[rel];
        vanished++;
      }
    }
    const workflowGone = Boolean(prev?.workflow) && !remote.has(`${prefix}workflow.tar.zst`);
    if (vanished || workflowGone) {
      log(
        `${t.identifier}: ${vanished} archived session(s)${workflowGone ? ' + workflow' : ''} ` +
          `missing from the bucket — re-uploading`,
      );
    }

    // Pass 1 — stat everything and work out whether this unit is triggered.
    interface Candidate {
      rel: string;
      abs: string;
      size: number;
      mtimeMs: number;
      changed: boolean;
    }
    const candidates: Candidate[] = [];
    for (const rel of sessionFiles(t.transcriptDir)) {
      const abs = join(t.transcriptDir, rel);
      try {
        const st = statSync(abs);
        candidates.push({
          rel,
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          changed: needsUpload(sessions[rel], st.size, st.mtimeMs),
        });
      } catch {
        continue; // pruned or rotated between readdir and stat
      }
    }
    // `sinceMs` narrows only the TRIGGER (a cheap "did anything happen lately"
    // filter for the nightly run) — never which files get uploaded.
    const triggered =
      force || workflowGone || candidates.some((c) => c.changed && c.mtimeMs >= sinceMs);
    res.skipped = triggered ? candidates.filter((c) => !c.changed).length : candidates.length;
    res.localSessions = candidates.length;
    res.upToDate = !triggered;

    // Say so out loud. "0 file(s)" alone is indistinguishable from a failure —
    // the user cannot tell "already safe" from "silently did nothing", and a
    // no-op click reads as a broken button.
    if (!triggered && candidates.length > 0 && targets.length <= 5) {
      const known = Object.keys(prev?.sessions ?? {}).length;
      const when = prev?.lastArchivedAt
        ? ` (last backed up ${new Date(prev.lastArchivedAt).toLocaleString()})`
        : '';
      log(
        `${t.identifier}: up to date — ${candidates.length} session file(s) on disk, ` +
          `${known} already in the bucket, nothing changed${when}`,
      );
    }

    // Pass 2 — the unit is in play, so bring the whole worktree up to date.
    const due = triggered ? candidates.filter((x) => force || x.changed) : [];
    for (const c of due) {
      const { rel, abs, size, mtimeMs } = c;

      const object = `${prefix}transcript/${rel}.zst`;
      if (dryRun) {
        log(`would upload ${t.identifier}/${rel} → gs://${gcs.bucket}/${object}`);
        res.uploaded.push(rel);
        uploadedCount++;
        continue;
      }

      try {
        sessions[rel] = await compressAndStamp({
          gcs,
          zstdPath,
          file: abs,
          object,
          size,
          mtimeMs,
          worktreePath: t.worktreePath,
          transcriptDir: t.transcriptDir,
        });
        res.uploaded.push(rel);
        uploadedCount++;
        log(`uploaded ${t.identifier}/${rel} (${size} B)`);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        res.errors.push(`${rel}: ${msg}`);
        errorCount++;
        log(`FAILED ${t.identifier}/${rel} — ${msg}`);
      }
    }

    // Workflow travels with the transcript: a triggered unit refreshes it too,
    // even if every session file turned out to be already uploaded. Under
    // `force` (an explicit archive — a removal, or a manual --force) it goes up
    // regardless, since a worktree whose transcripts were already pruned still
    // has workflow state worth keeping.
    let workflow = workflowGone ? null : prev?.workflow ?? null;
    if (t.workflowDir && (force || triggered || workflowGone)) {
      const object = `${prefix}workflow.tar.zst`;
      if (dryRun) {
        log(`would refresh ${t.identifier} workflow → gs://${gcs.bucket}/${object}`);
        res.workflow = true;
      } else {
        const tmp = join(tmpdir(), `ksflow-sweep-wf-${process.pid}.tar.zst`);
        try {
          await buildTarZst(dirname(t.workflowDir), basename(t.workflowDir), tmp, zstdPath, [
            '-19',
          ]);
          await uploadFile(gcs, tmp, object);
          workflow = {
            object: `gs://${gcs.bucket}/${object}`,
            size: statSync(tmp).size,
            uploadedAt: new Date().toISOString(),
          };
          res.workflow = true;
          log(`refreshed ${t.identifier} workflow.tar.zst`);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          res.errors.push(`workflow: ${msg}`);
          errorCount++;
          log(`FAILED ${t.identifier} workflow — ${msg}`);
        } finally {
          try {
            unlinkSync(tmp);
          } catch {
            // best-effort temp cleanup
          }
        }
      }
    }

    // Only record a unit that actually has something in the bucket. Writing an
    // entry for every worktree scanned left 28 empty records in a 33-worktree
    // project, which the board would then render as units "known to the backup"
    // with nothing behind them.
    const hasContent = Object.keys(sessions).length > 0 || workflow !== null;
    if (!dryRun && hasContent && (res.uploaded.length > 0 || res.errors.length === 0)) {
      const unit: UnitArchive = {
        identifier: t.identifier,
        worktreePath: t.worktreePath,
        transcriptDir: t.transcriptDir,
        sessions,
        workflow,
        lastArchivedAt:
          res.uploaded.length > 0 ? new Date().toISOString() : prev?.lastArchivedAt ?? '',
      };
      index.units[t.identifier] = unit;
      persistIndex(index, log);

      // Per-unit manifest, uploaded alongside the data it describes. The local
      // index is one file for the whole machine — lose it and every unit goes
      // blind at once — whereas this travels WITH the unit: one manifest per
      // worktree, owned by that worktree, readable straight from the console,
      // and enough to rebuild the index entry exactly. Object metadata can do
      // the same job but only via a full listing, and is easy to overlook.
      if (res.uploaded.length > 0 || res.workflow) {
        await uploadJson(gcs, `${prefix}${MANIFEST_NAME}`, unit).catch((e: Error) =>
          log(`WARNING: could not write ${t.identifier} manifest — ${e.message}`),
        );
      }
    }
    results.push(res);
  }

  if (!dryRun) {
    index.lastSweepAt = new Date().toISOString();
    persistIndex(index, log);
  }
  return { units: results, uploadedCount, errorCount, dryRun };
}

/** The index is a CACHE of what was uploaded, so a failed write must never fail
 * the sweep: the objects are already in the bucket, and the removal hook aborts
 * a worktree deletion on any non-zero exit. Losing the index only costs a
 * redundant upload next run. */
function persistIndex(index: ArchiveIndex, log: (msg: string) => void): void {
  try {
    writeArchiveIndex(index);
  } catch (e) {
    log(`WARNING: could not write the archive index — ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Rebuild the local index for one unit from the bucket.
 *
 * The index is a cache, and losing it (new machine, cleared plugin data dir) used
 * to mean the board went blind and the next sweep re-uploaded everything. Since
 * uploads stamp the source size/mtime onto each object, a single listing is
 * enough to reconstruct exactly what a sweep would have written.
 *
 * Objects uploaded before stamping existed carry no source metadata; those are
 * recorded with size/mtime 0 so they read as "changed" and re-upload once, which
 * is the safe direction.
 */
export async function reindexUnit(
  identifier: string,
  target: Pick<UnitTarget, 'worktreePath' | 'transcriptDir'> | null,
  gcs: GcsConfig,
  log: (msg: string) => void,
): Promise<UnitArchive | null> {
  const unitRoot = unitPrefix(gcs, identifier);

  // The manifest is authoritative when present: it was written by the sweep that
  // uploaded the data, so it needs no reconstruction.
  const manifest = await downloadJson<UnitArchive>(gcs, `${unitRoot}${MANIFEST_NAME}`);
  if (manifest?.sessions && manifest.transcriptDir) {
    log(
      `${identifier}: ${Object.keys(manifest.sessions).length} session(s) from manifest` +
        `${manifest.workflow ? ' + workflow' : ''}`,
    );
    return manifest;
  }

  const objects = await listObjects(gcs, unitRoot);
  if (objects.length === 0) {
    log(`${identifier}: nothing in the bucket`);
    return null;
  }

  const sessions: Record<string, ArchivedSession> = {};
  let workflow: UnitArchive['workflow'] = null;
  let unstamped = 0;
  // Prefer the location stamped on the objects: for a unit whose worktree is
  // gone, that is the only surviving record of where its transcripts belonged.
  let worktreePath = target?.worktreePath ?? '';
  let transcriptDir = target?.transcriptDir ?? '';
  const transcriptPrefix = `${unitRoot}transcript/`;

  for (const obj of objects) {
    if (obj.name === `${unitRoot}workflow.tar.zst`) {
      workflow = {
        object: `gs://${gcs.bucket}/${obj.name}`,
        size: obj.size,
        uploadedAt: obj.updated ?? '',
      };
      continue;
    }
    if (obj.name === `${unitRoot}${MANIFEST_NAME}`) continue;
    if (!obj.name.startsWith(transcriptPrefix) || !obj.name.endsWith('.zst')) continue;
    const rel = obj.name.slice(transcriptPrefix.length, -'.zst'.length);
    if (obj.srcSize === undefined || obj.srcMtimeMs === undefined) unstamped++;
    if (!worktreePath && obj.srcWorktree) worktreePath = obj.srcWorktree;
    if (!transcriptDir && obj.srcTranscriptDir) transcriptDir = obj.srcTranscriptDir;
    sessions[rel] = {
      size: obj.srcSize ?? 0,
      mtimeMs: obj.srcMtimeMs ?? 0,
      object: `gs://${gcs.bucket}/${obj.name}`,
      uploadedAt: obj.updated ?? '',
    };
  }

  log(
    `${identifier}: ${Object.keys(sessions).length} session object(s)` +
      `${workflow ? ' + workflow' : ''}` +
      `${unstamped ? `, ${unstamped} without source metadata (will re-upload once)` : ''}`,
  );

  if (!transcriptDir) {
    log(`${identifier}: no stamped transcript dir and no live worktree — cannot place a restore`);
    return null;
  }
  return {
    identifier,
    worktreePath,
    transcriptDir,
    sessions,
    workflow,
    lastArchivedAt: objects.reduce((latest, o) => (o.updated && o.updated > latest ? o.updated : latest), ''),
  };
}

/** Every unit identifier that has objects in the bucket (top-level prefixes). */
export async function bucketUnits(gcs: GcsConfig): Promise<string[]> {
  const root = gcs.prefix ? `${gcs.prefix}/` : '';
  const objects = await listObjects(gcs, root);
  const ids = new Set<string>();
  for (const o of objects) {
    const rest = o.name.slice(root.length);
    const id = rest.split('/')[0];
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Rebuild the whole local index from the bucket, for every unit found there.
 *
 * Live worktrees supply their own transcript dir; units whose worktree is gone
 * fall back to the location stamped on their objects. Returns the number of
 * units recovered and skipped.
 */
export async function reindexAll(
  projectPath: string | null,
  gcs: GcsConfig,
  log: (msg: string) => void,
): Promise<{ recovered: number; skipped: number }> {
  // Three sources for "where does this unit's transcript live", in order of
  // authority: a live worktree, the completed-unit record in the main checkout's
  // workflow tree (worktree removed, state.yaml still committed), and finally the
  // location stamped on the objects themselves (inside reindexUnit). The middle
  // one matters most for old archives: objects uploaded before stamping existed
  // carry no location, and without it 35 of 40 units in the first real bucket
  // could not be placed.
  const known = new Map<string, UnitTarget>();
  if (projectPath) {
    for (const t of discoverCompletedTargets(projectPath)) known.set(t.identifier, t);
    for (const t of discoverTargets(projectPath)) known.set(t.identifier, t); // live wins
  }

  const index = readArchiveIndex();
  let recovered = 0;
  let skipped = 0;
  for (const id of await bucketUnits(gcs)) {
    const unit = await reindexUnit(id, known.get(id) ?? null, gcs, log);
    if (!unit) {
      skipped++;
      continue;
    }
    index.units[id] = unit;
    recovered++;
  }
  writeArchiveIndex(index);
  return { recovered, skipped };
}

// ── status ───────────────────────────────────────────────────────────────────
export interface UnitStatus {
  identifier: string;
  transcriptDir: string;
  worktreePath: string;
  worktreeExists: boolean;
  localSessions: number;
  cloudSessions: number;
  /** Archived but no longer on disk → restorable. */
  missingCount: number;
  /** On disk but not archived, or changed since it was. */
  pendingCount: number;
  /** Only a pre-migration transcript.tar.zst exists for this unit. */
  legacyOnly: boolean;
  lastArchivedAt: string | null;
}

/**
 * Per-unit backup status, computed from the BUCKET rather than from the local
 * index.
 *
 * The index only lists units this machine has backed up, so a unit archived
 * before the index existed — or on another machine, or after the index was
 * cleared — appeared to have no backup at all, and the board offered no Restore
 * for precisely the sessions that had been pruned locally. Listing the bucket
 * once and reading the source stamps off the objects removes that blind spot;
 * the index is consulted only for `lastArchivedAt` and for objects too old to
 * carry stamps.
 */
export async function unitStatuses(
  projectPath: string | null,
  gcs: GcsConfig,
): Promise<UnitStatus[]> {
  const root = gcs.prefix ? `${gcs.prefix}/` : '';
  const objects = await listObjects(gcs, root);
  const index = readArchiveIndex();

  // Where each unit's transcripts live: live worktree, else completed-unit
  // record, else the location stamped on its objects, else the index.
  const targets = new Map<string, UnitTarget>();
  if (projectPath) {
    for (const t of discoverCompletedTargets(projectPath)) targets.set(t.identifier, t);
    for (const t of discoverTargets(projectPath)) targets.set(t.identifier, t);
  }

  interface Acc {
    archived: Map<string, { size?: number; mtimeMs?: number }>;
    legacy: boolean;
    stampedDir?: string;
    stampedWorktree?: string;
    newest: string;
  }
  const byUnit = new Map<string, Acc>();
  for (const o of objects) {
    const rest = o.name.slice(root.length);
    const id = rest.split('/')[0];
    if (!id || id.startsWith('_legacy-backup')) continue;
    const acc: Acc = byUnit.get(id) ?? { archived: new Map(), legacy: false, newest: '' };
    if (o.updated && o.updated > acc.newest) acc.newest = o.updated;
    const tail = rest.slice(id.length + 1);
    if (tail === 'transcript.tar.zst') acc.legacy = true;
    else if (tail.startsWith('transcript/') && tail.endsWith('.zst')) {
      acc.archived.set(tail.slice('transcript/'.length, -'.zst'.length), {
        size: o.srcSize,
        mtimeMs: o.srcMtimeMs,
      });
      if (!acc.stampedDir && o.srcTranscriptDir) acc.stampedDir = o.srcTranscriptDir;
      if (!acc.stampedWorktree && o.srcWorktree) acc.stampedWorktree = o.srcWorktree;
    }
    byUnit.set(id, acc);
  }

  // Live/known units with no objects yet still deserve a row: the board wants to
  // show "nothing backed up" for them, not omit them.
  for (const id of targets.keys()) {
    if (!byUnit.has(id)) {
      const empty: Acc = { archived: new Map(), legacy: false, newest: '' };
      byUnit.set(id, empty);
    }
  }

  const out: UnitStatus[] = [];
  for (const [id, acc] of byUnit) {
    const known = targets.get(id);
    const recorded = index.units[id];
    const transcriptDir =
      known?.transcriptDir || acc.stampedDir || recorded?.transcriptDir || '';
    const worktreePath = known?.worktreePath || acc.stampedWorktree || recorded?.worktreePath || '';

    const local = new Map<string, { size: number; mtimeMs: number }>();
    if (transcriptDir) {
      for (const rel of sessionFiles(transcriptDir)) {
        try {
          const st = statSync(join(transcriptDir, rel));
          local.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished mid-scan
        }
      }
    }

    const missing = [...acc.archived.keys()].filter((rel) => !local.has(rel));
    const pending = [...local.entries()].filter(([rel, st]) => {
      const a = acc.archived.get(rel);
      if (!a) return true; // not archived at all
      // An object without stamps (pre-migration) cannot be compared; treat it as
      // archived rather than nagging about every legacy unit forever.
      if (a.size === undefined || a.mtimeMs === undefined) return false;
      return a.size !== st.size || Math.floor(a.mtimeMs) !== Math.floor(st.mtimeMs);
    });

    out.push({
      identifier: id,
      transcriptDir,
      worktreePath,
      worktreeExists: Boolean(worktreePath) && existsSync(worktreePath),
      localSessions: local.size,
      cloudSessions: acc.archived.size,
      missingCount: missing.length,
      pendingCount: pending.length,
      legacyOnly: acc.legacy && acc.archived.size === 0,
      lastArchivedAt: recorded?.lastArchivedAt || acc.newest || null,
    });
  }
  return out.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

// ── restore ──────────────────────────────────────────────────────────────────
export interface RestoreOpts {
  target: UnitTarget;
  gcs: GcsConfig;
  zstdPath: string;
  /** Overwrite a local session file that already exists (default: never). */
  overwrite?: boolean;
  dryRun?: boolean;
  log: (msg: string) => void;
}

export interface RestoreResult {
  restored: string[];
  keptLocal: string[]; // present locally, left alone — local always wins
  errors: string[];
  workflowObject: string | null;
}

/**
 * Pull a unit's session objects back into ~/.claude/projects/<encoded>.
 *
 * Local files win by default: a transcript on disk is the live one the CLI may
 * be appending to, and clobbering it with an older cloud copy would lose the
 * newest turns. Only the files that are MISSING locally get written — which is
 * exactly the pruned-after-30-days case this exists for.
 *
 * Note this restores the conversation, not the worktree: if the worktree itself
 * is gone, the encoded transcript path won't match any live directory and
 * `--resume` still won't list the session until that worktree exists again.
 */
export async function restoreUnit(opts: RestoreOpts): Promise<RestoreResult> {
  const { target, gcs, zstdPath, overwrite = false, dryRun = false, log } = opts;
  const unitRoot = unitPrefix(gcs, target.identifier);
  const prefix = `${unitRoot}transcript/`;
  const objects = await listObjects(gcs, prefix);
  const out: RestoreResult = { restored: [], keptLocal: [], errors: [], workflowObject: null };

  if (objects.length === 0) {
    // Nothing in the per-file layout. Units archived by the removal hook before
    // this feature existed (and by backfill-archive) hold a single
    // transcript.tar.zst instead — 35 of them in the first bucket this ran
    // against. Falling back keeps those restorable instead of reporting an empty
    // archive for work that is definitely backed up.
    const legacy = await listObjects(gcs, `${unitRoot}transcript.tar.zst`);
    if (legacy.length > 0) {
      log(`no per-file objects — restoring from the legacy ${legacy[0].name}`);
      return restoreFromTarball(legacy[0].name, { ...opts, unitRoot });
    }
    log(`no cloud transcript objects under gs://${gcs.bucket}/${prefix}`);
    return out;
  }

  for (const obj of objects) {
    if (!obj.name.endsWith('.jsonl.zst')) continue;
    const rel = obj.name.slice(prefix.length, -'.zst'.length); // <id>.jsonl | subagents/<id>.jsonl
    const dest = join(target.transcriptDir, rel);
    if (existsSync(dest) && !overwrite) {
      out.keptLocal.push(rel);
      continue;
    }
    if (dryRun) {
      log(`would restore ${rel} → ${dest}`);
      out.restored.push(rel);
      continue;
    }
    const tmpZst = join(tmpdir(), `ksflow-restore-${process.pid}-${out.restored.length}.zst`);
    const tmpOut = `${tmpZst}.jsonl`;
    try {
      await downloadObject(gcs, obj.name, tmpZst);
      await decompressFile(tmpZst, tmpOut, zstdPath);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmpOut, dest); // same filesystem ($TMPDIR is on /) — atomic
      out.restored.push(rel);
      log(`restored ${rel}`);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      out.errors.push(`${rel}: ${msg}`);
      log(`FAILED ${rel} — ${msg}`);
    } finally {
      for (const f of [tmpZst, tmpOut]) {
        try {
          unlinkSync(f);
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  }

  const wf = await listObjects(gcs, `${unitPrefix(gcs, target.identifier)}workflow.tar.zst`);
  out.workflowObject = wf.length > 0 ? `gs://${gcs.bucket}/${wf[0].name}` : null;
  return out;
}

/**
 * Download and unpack a legacy `transcript.tar.zst` into `workDir`, returning the
 * directory the tarball produced.
 *
 * The archive was built as `tar -C <parent> -- <encodedDirName>`, so its entries
 * are nested one level down under a name we do not want to assume — take whatever
 * directory actually appeared. tar preserves each file's mtime, which is what
 * makes a converted object's source stamp match what a local sweep would compute.
 */
export async function extractLegacyTarball(
  gcs: GcsConfig,
  object: string,
  zstdPath: string,
  workDir: string,
): Promise<string> {
  const zst = join(workDir, 'transcript.tar.zst');
  const tar = join(workDir, 'transcript.tar');
  await downloadObject(gcs, object, zst);
  await decompressFile(zst, tar, zstdPath);
  const untar = spawnSync('/usr/bin/tar', ['-xf', tar, '-C', workDir], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`tar -xf: ${(untar.stderr || '').trim()}`);
  const roots = readdirSync(workDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(workDir, e.name));
  if (!roots[0]) throw new Error('tarball contained no directory');
  return roots[0];
}

/**
 * Restore from the legacy whole-directory `transcript.tar.zst`.
 *
 * Unpacks to a temp dir and copies in only the sessions MISSING locally, same
 * rule as the per-file path — a tarball is a snapshot of the directory as it was
 * at archive time, so blindly overwriting could replace a live transcript with
 * an older copy of itself.
 *
 * The tarball was built as `tar -C <parent> -- <encodedDirName>`, so its entries
 * are nested one level under that directory name.
 */
async function restoreFromTarball(
  object: string,
  opts: RestoreOpts & { unitRoot: string },
): Promise<RestoreResult> {
  const { target, gcs, zstdPath, overwrite = false, dryRun = false, log, unitRoot } = opts;
  const out: RestoreResult = { restored: [], keptLocal: [], errors: [], workflowObject: null };

  const workDir = mkdtempSync(join(tmpdir(), 'ksflow-legacy-'));
  try {
    const src = await extractLegacyTarball(gcs, object, zstdPath, workDir);

    for (const rel of sessionFiles(src)) {
      const dest = join(target.transcriptDir, rel);
      if (existsSync(dest) && !overwrite) {
        out.keptLocal.push(rel);
        continue;
      }
      if (dryRun) {
        log(`would restore ${rel} → ${dest} (from legacy tarball)`);
        out.restored.push(rel);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(src, rel), dest);
      out.restored.push(rel);
      log(`restored ${rel} (legacy tarball)`);
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    out.errors.push(`legacy tarball: ${msg}`);
    log(`FAILED legacy restore — ${msg}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const wf = await listObjects(gcs, `${unitRoot}workflow.tar.zst`);
  out.workflowObject = wf.length > 0 ? `gs://${gcs.bucket}/${wf[0].name}` : null;
  return out;
}
