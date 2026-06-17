// lib/archive-core.ts — compress + upload a unit's conversation to GCS.
//
// Shared by the `archive` CLI (live worktree-removal hook) and the
// `backfill-archive` script. Builds TWO zstd-max tarballs — transcript.tar.zst
// (the raw ~/.claude/projects session folder, incl. subagents) and
// workflow.tar.zst (state.yaml + resources) — and uploads both under a
// per-run object prefix. Pure I/O orchestration; callers resolve the dirs.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Storage, type StorageOptions } from '@google-cloud/storage';
import { REQUIRED_BINARIES, type RequiredBinary } from './archive-deps.js';
import { dataDir } from './config.js';

// ── settings + config ────────────────────────────────────────────────────────
/** The `gcsArchive` block persisted in board-settings.json (UI-editable). */
export interface ArchiveSettings {
  enabled: boolean;
  bucket: string;
  prefix?: string;
}

/** Resolved GCS connection + creds (env wins over settings for the bucket). */
export interface GcsConfig {
  bucket: string;
  prefix?: string;
  credentials?: string; // path to a service-account JSON
  clientEmail?: string;
  privateKey?: string;
  projectId?: string;
}

const DEFAULT_SETTINGS: ArchiveSettings = { enabled: false, bucket: '' };

/** Read the `gcsArchive` block out of board-settings.json (disabled if absent). */
export function readArchiveSettings(): ArchiveSettings {
  try {
    const s = JSON.parse(readFileSync(join(dataDir(), 'board-settings.json'), 'utf8'));
    const g = s.gcsArchive;
    if (!g || typeof g !== 'object') return DEFAULT_SETTINGS;
    return {
      enabled: g.enabled === true,
      bucket: typeof g.bucket === 'string' ? g.bucket : '',
      prefix: typeof g.prefix === 'string' && g.prefix ? g.prefix : undefined,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Merge settings + env into a GcsConfig, reporting what's missing. Sensitive
 * creds come from env only; the bucket may come from either (env wins). */
export function resolveGcsConfig(settings: ArchiveSettings): {
  config: GcsConfig | null;
  missing: string[];
} {
  const bucket = (process.env.GCS_BUCKET || settings.bucket || '').trim();
  const credentials = process.env.GCS_CREDENTIALS?.trim() || undefined;
  const clientEmail = process.env.GCS_CLIENT_EMAIL?.trim() || undefined;
  const privateKey = process.env.GCS_PRIVATE_KEY || undefined;
  const projectId = process.env.GCS_PROJECT_ID?.trim() || undefined;

  const missing: string[] = [];
  if (!bucket) missing.push('bucket (set GCS_BUCKET or the bucket field in Settings)');
  if (!credentials && !(clientEmail && privateKey)) {
    missing.push('credentials (set GCS_CREDENTIALS, or GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY)');
  }
  if (missing.length) return { config: null, missing };
  return {
    config: { bucket, prefix: settings.prefix, credentials, clientEmail, privateKey, projectId },
    missing: [],
  };
}

function makeStorage(gcs: GcsConfig): Storage {
  const opts: StorageOptions = {};
  if (gcs.projectId) opts.projectId = gcs.projectId;
  if (gcs.clientEmail && gcs.privateKey) {
    // env vars carry the key with literal "\n" escapes — restore real newlines
    // (mirrors firestore.ts's resolveCredential).
    opts.credentials = {
      client_email: gcs.clientEmail,
      private_key: gcs.privateKey.replace(/\\n/g, '\n'),
    };
  } else if (gcs.credentials) {
    opts.keyFilename = gcs.credentials;
  }
  // else: Application Default Credentials.
  return new Storage(opts);
}

// ── binary preflight ──────────────────────────────────────────────────────────
/** Absolute path to a binary, resolving through the user's login shell so
 * homebrew's /opt/homebrew/bin (absent from the launchd/minimal PATH) is seen. */
export function resolveBinary(name: string): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch {
    // not on the current PATH — fall through to the shell prelude
  }
  try {
    const prelude =
      '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; command -v ' +
      name;
    const out = execFileSync('/bin/zsh', ['-c', prelude], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Required binaries that are NOT installed (for the on-enable prompt). */
export function missingBinaries(): RequiredBinary[] {
  return REQUIRED_BINARIES.filter((b) => resolveBinary(b.name) === null);
}

// ── compression + upload ──────────────────────────────────────────────────────
/** Build `<out>` = a zstd --ultra -22 tarball of `<parentDir>/<base>`, via the
 * portable pipe `tar -cf - -C parent -- base | zstd --ultra -22 -T0 -o out`
 * (macOS bsdtar lacks GNU's -I). The `--` is load-bearing: encoded transcript
 * dir names start with "-" (e.g. "-Users-…"), which tar would otherwise parse as
 * option flags ("Invalid replacement flag"). `zstdPath` is an absolute path. */
function buildTarZst(
  parentDir: string,
  base: string,
  out: string,
  zstdPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('/usr/bin/tar', ['-cf', '-', '-C', parentDir, '--', base]);
    const zstd = spawn(zstdPath, ['--ultra', '-22', '-T0', '-f', '-o', out]);
    tar.stdout.pipe(zstd.stdin);

    let tarErr = '';
    let zErr = '';
    tar.stderr.on('data', (d: Buffer) => (tarErr += d.toString()));
    zstd.stderr.on('data', (d: Buffer) => (zErr += d.toString()));

    let tarCode: number | null = null;
    let zCode: number | null = null;
    let settled = false;
    const check = (): void => {
      if (settled || tarCode === null || zCode === null) return;
      settled = true;
      if (tarCode === 0 && zCode === 0) resolve();
      else reject(new Error(`tar(${tarCode}) zstd(${zCode}): ${tarErr.trim()} ${zErr.trim()}`.trim()));
    };
    tar.on('error', (e) => !settled && ((settled = true), reject(e)));
    zstd.on('error', (e) => !settled && ((settled = true), reject(e)));
    tar.on('close', (c) => ((tarCode = c ?? 0), check()));
    zstd.on('close', (c) => ((zCode = c ?? 0), check()));
  });
}

export interface ArchiveUnitOpts {
  transcriptDir: string | null; // ~/.claude/projects/<enc> (null = skip)
  workflowDir: string | null; // the unit's workflow dir (null = skip)
  objectPrefix: string; // e.g. "<identifier>/" — trailing slash
  dedupPrefix: string; // existence-check prefix, e.g. "<identifier>/"
  gcs: GcsConfig;
  zstdPath: string;
  force: boolean; // skip the dedup existence check + upload regardless
  log: (msg: string) => void;
}

export interface ArchiveResult {
  status: 'uploaded' | 'skipped-existing' | 'nothing';
  objects: string[];
}

/** Compress each present tree and upload both objects under objectPrefix.
 * When !force, skips entirely if any object already exists at dedupPrefix. */
export async function archiveUnit(opts: ArchiveUnitOpts): Promise<ArchiveResult> {
  const { transcriptDir, workflowDir, objectPrefix, dedupPrefix, gcs, zstdPath, force, log } = opts;
  const trees = [
    transcriptDir ? { dir: transcriptDir, out: 'transcript.tar.zst' } : null,
    workflowDir ? { dir: workflowDir, out: 'workflow.tar.zst' } : null,
  ].filter((t): t is { dir: string; out: string } => t !== null);
  if (trees.length === 0) return { status: 'nothing', objects: [] };

  const bucket = makeStorage(gcs).bucket(gcs.bucket);

  if (!force) {
    const [existing] = await bucket.getFiles({ prefix: dedupPrefix, maxResults: 1 });
    if (existing.length > 0) {
      log(`skip — already archived under gs://${gcs.bucket}/${dedupPrefix}`);
      return { status: 'skipped-existing', objects: [] };
    }
  }

  const objects: string[] = [];
  for (const t of trees) {
    const tmp = join(tmpdir(), `ksflow-${t.out}-${process.pid}-${objects.length}.tmp`);
    log(`compressing ${t.dir} → ${t.out} (zstd --ultra -22)…`);
    await buildTarZst(dirname(t.dir), basename(t.dir), tmp, zstdPath);
    const dest = objectPrefix + t.out;
    log(`uploading gs://${gcs.bucket}/${dest}…`);
    await bucket.upload(tmp, { destination: dest });
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
    objects.push(`gs://${gcs.bucket}/${dest}`);
  }
  return { status: 'uploaded', objects };
}
