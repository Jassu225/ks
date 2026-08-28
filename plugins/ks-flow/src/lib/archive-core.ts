// lib/archive-core.ts — GCS plumbing for the transcript/workflow backup.
//
// Settings + credential resolution, binary discovery, and the primitives the one
// uploader (lib/transcript-archive.ts sweep()) builds on: compress/decompress a
// file, tar a directory, upload, list, download.
//
// There used to be a second uploader here (`archiveUnit`, a whole-directory
// transcript.tar.zst for the removal hook and backfill). It is gone: two
// formats in one bucket meant the board could not restore anything archived at
// removal time. Existing tarballs stay readable — restore falls back to them.
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
export function buildTarZst(
  parentDir: string,
  base: string,
  out: string,
  zstdPath: string,
  zstdFlags: string[] = ['--ultra', '-22'],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('/usr/bin/tar', ['-cf', '-', '-C', parentDir, '--', base]);
    const zstd = spawn(zstdPath, [...zstdFlags, '-T0', '-f', '-o', out]);
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

// ── per-file objects (the daily transcript sweep) ─────────────────────────────
//
// The removal path above tars a whole directory. The daily sweep can't: local
// transcripts are pruned at 30 days, so re-tarring the directory would upload a
// tree that has LOST files and overwrite a good cloud copy with a lesser one.
// One object per session file removes that failure mode by construction —
// pruning locally can never delete anything in the bucket — and makes the sweep
// incremental instead of re-compressing every transcript nightly.
//
// Level 19 rather than --ultra -22: on JSONL the ratio difference is under a
// percent, and this runs unattended every day over many files.
const SWEEP_ZSTD_LEVEL = '-19';

/** Compress one file to `out` with `zstd -19 -T0`. */
export function compressFile(src: string, out: string, zstdPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zstd = spawn(zstdPath, [SWEEP_ZSTD_LEVEL, '-T0', '-f', '-o', out, '--', src]);
    let err = '';
    zstd.stderr.on('data', (d: Buffer) => (err += d.toString()));
    zstd.on('error', reject);
    zstd.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`zstd(${code}): ${err.trim()}`)),
    );
  });
}

/** Decompress one `.zst` file to `out`. */
export function decompressFile(src: string, out: string, zstdPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zstd = spawn(zstdPath, ['-d', '-f', '-o', out, '--', src]);
    let err = '';
    zstd.stderr.on('data', (d: Buffer) => (err += d.toString()));
    zstd.on('error', reject);
    zstd.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`zstd -d(${code}): ${err.trim()}`)),
    );
  });
}

/** Custom object metadata describing the SOURCE file an object was made from.
 *
 * Without this the bucket cannot answer "is this copy current?": an object's
 * `updated` is when we uploaded it, not when the session was written, and its
 * `size` is the COMPRESSED size, so neither can be compared with a local file.
 * Stamping the source's size and mtime makes the bucket self-describing, which
 * is what lets the local index be treated as a pure cache and rebuilt from a
 * single listing after it is lost (new machine, cleared data dir). */
export interface SourceStamp {
  srcSize: number;
  srcMtimeMs: number;
  /** Where this unit's transcripts live, and the worktree they belong to.
   * Recorded because the bucket otherwise cannot answer "restore to where?" for
   * a unit whose worktree has been removed — precisely the unit a restore is
   * for. Without it, a lost index makes those unrestorable. */
  srcWorktree?: string;
  srcTranscriptDir?: string;
}

/** Upload one local file to `dest` (an object name, no gs:// prefix). */
export async function uploadFile(
  gcs: GcsConfig,
  local: string,
  dest: string,
  stamp?: SourceStamp,
): Promise<void> {
  await makeStorage(gcs)
    .bucket(gcs.bucket)
    .upload(local, {
      destination: dest,
      ...(stamp
        ? {
            metadata: {
              metadata: {
                srcSize: String(stamp.srcSize),
                srcMtimeMs: String(Math.floor(stamp.srcMtimeMs)),
                ...(stamp.srcWorktree ? { srcWorktree: stamp.srcWorktree } : {}),
                ...(stamp.srcTranscriptDir ? { srcTranscriptDir: stamp.srcTranscriptDir } : {}),
              },
            },
          }
        : {}),
    });
}

/** Upload a small in-memory payload (the per-unit manifest). Kept uncompressed
 * so it is readable straight from the GCS console. */
export async function uploadJson(gcs: GcsConfig, dest: string, value: unknown): Promise<void> {
  await makeStorage(gcs)
    .bucket(gcs.bucket)
    .file(dest)
    .save(JSON.stringify(value, null, 2), {
      contentType: 'application/json',
      resumable: false,
    });
}

/** Read a JSON object back, or null when it is absent/unparseable. */
export async function downloadJson<T>(gcs: GcsConfig, object: string): Promise<T | null> {
  try {
    const [buf] = await makeStorage(gcs).bucket(gcs.bucket).file(object).download();
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export interface RemoteObject {
  name: string;
  /** COMPRESSED size of the object — not the source file's size. */
  size: number;
  /** When the object was written, i.e. upload time — not the source's mtime. */
  updated: string | null;
  /** The source file's size/mtime, when the upload stamped them (see
   * SourceStamp). Absent on objects written before stamping existed. */
  srcSize?: number;
  srcMtimeMs?: number;
  srcWorktree?: string;
  srcTranscriptDir?: string;
}

/** List every object under `prefix`. Used by restore and by the status route to
 * answer "is there a cloud copy?" without trusting the local index. */
export async function listObjects(gcs: GcsConfig, prefix: string): Promise<RemoteObject[]> {
  const [files] = await makeStorage(gcs).bucket(gcs.bucket).getFiles({ prefix });
  return files.map((f) => {
    const custom = (f.metadata?.metadata ?? {}) as Record<string, string | undefined>;
    const num = (v: string | undefined): number | undefined => {
      const n = Number(v);
      return v !== undefined && Number.isFinite(n) ? n : undefined;
    };
    return {
      name: f.name,
      size: Number(f.metadata?.size ?? 0),
      updated: (f.metadata?.updated as string | undefined) ?? null,
      srcSize: num(custom.srcSize),
      srcMtimeMs: num(custom.srcMtimeMs),
      srcWorktree: custom.srcWorktree,
      srcTranscriptDir: custom.srcTranscriptDir,
    };
  });
}

/** Server-side copy — no download/upload round trip, so a whole-bucket safety
 * copy costs no egress. */
export async function copyObject(gcs: GcsConfig, src: string, dest: string): Promise<void> {
  const bucket = makeStorage(gcs).bucket(gcs.bucket);
  await bucket.file(src).copy(bucket.file(dest));
}

/** Delete one object. Used only after a verified copy exists. */
export async function deleteObject(gcs: GcsConfig, object: string): Promise<void> {
  await makeStorage(gcs).bucket(gcs.bucket).file(object).delete();
}

/** Download one object to a local path. */
export async function downloadObject(gcs: GcsConfig, object: string, dest: string): Promise<void> {
  await makeStorage(gcs).bucket(gcs.bucket).file(object).download({ destination: dest });
}
