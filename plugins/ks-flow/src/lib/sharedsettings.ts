// lib/sharedsettings.ts — the shared settings (meta/settings) and this
// device's board-settings.json, kept in step.
//
// meta/settings holds the blocks every device shares (briefing, notes,
// reminders, gcsArchive, transcriptBackup) and masterDeviceId.
// <dataDir>/board-settings.json stays the LOCAL MIRROR: the daemon and the
// synchronous readers (notify-stop.sh, `ks-flow backup-enabled`,
// archive-core.ts, the board's run-command and masterFiles.ts) keep reading
// the file, and the local blocks (removeCommand, …) live only there.
//
// Both copies carry `sharedUpdatedAt`, the time the shared blocks were last
// saved. The board's /api/settings stamps the file and the store with the
// same time; the store write may sit in the offline outbox for a while. The
// rule, per block set:
//   - store newer than the file (or the file has no stamp): the store's
//     blocks replace the file's (a block the store lacks is removed);
//   - same stamp: nothing to do;
//   - file newer: a save on this device the store has not got yet. While a
//     meta/settings write waits in the outbox, nothing happens (an older store
//     copy must not overwrite the newer local save); with none waiting, the
//     file's blocks are pushed to the store, so every device ends on the
//     newest save.
// masterDeviceId is always mirrored from the store (Settings → Devices writes
// it alone, without a stamp); its presence in the file also tells a reader
// with no store at hand that the store is in device mode.
//
// Before the device backfill there is no meta/settings: nothing here runs and
// the file is the only copy, as it always was.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_BLOCKS } from './device-backfill.js';
import type { DeviceStore, SettingsDoc } from './db/types.js';

export { SHARED_BLOCKS };

export const BOARD_SETTINGS_FILE = 'board-settings.json';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const stamp = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Deep-equal for JSON values (key order ignored). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

/** The file's shared blocks, as a store patch (blocks that are not objects are left out). */
export function fileShared(file: Json): Partial<SettingsDoc> {
  const out: Json = {};
  for (const k of SHARED_BLOCKS) if (isObject(file[k])) out[k] = file[k];
  return out as Partial<SettingsDoc>;
}

export interface Reconcile {
  /** The new file content (local blocks kept), or null when the file stays. */
  file: Json | null;
  /** What to merge into meta/settings, or null. */
  storePatch: Partial<SettingsDoc> | null;
  why: string;
}

/** What to do with the file and the store, given both (pure; see the header). */
export function reconcile(file: Json, store: SettingsDoc, opts: { pendingStoreWrite: boolean }): Reconcile {
  const fileAt = stamp(file.sharedUpdatedAt);
  const storeAt = stamp(store.sharedUpdatedAt);
  let next: Json | null = null;
  const edit = (): Json => (next ??= { ...file });
  let storePatch: Partial<SettingsDoc> | null = null;
  let why = 'in step';

  if (typeof store.masterDeviceId === 'string' && store.masterDeviceId && file.masterDeviceId !== store.masterDeviceId) {
    edit().masterDeviceId = store.masterDeviceId;
    why = 'master device mirrored';
  }

  if (storeAt > fileAt || (!fileAt && !storeAt)) {
    // The store's copy is the newer one (or neither was ever stamped: the store wins).
    const n = edit();
    let changed = false;
    for (const k of SHARED_BLOCKS) {
      const v = (store as unknown as Json)[k];
      if (isObject(v)) {
        if (!same(n[k], v)) {
          n[k] = v;
          changed = true;
        }
      } else if (k in n) {
        delete n[k];
        changed = true;
      }
    }
    if (storeAt && n.sharedUpdatedAt !== storeAt) {
      n.sharedUpdatedAt = storeAt;
      changed = true;
    }
    if (changed) why = 'store copy applied';
  } else if (fileAt > storeAt) {
    if (opts.pendingStoreWrite) why = 'local save waiting in the outbox';
    else {
      storePatch = { ...fileShared(file), sharedUpdatedAt: fileAt };
      why = 'local save pushed to the store';
    }
  }
  if (next && same(next, file)) next = null;
  return { file: next, storePatch, why };
}

// ── the file ────────────────────────────────────────────────────────────────

export function boardSettingsPath(dataDir: string): string {
  return join(dataDir, BOARD_SETTINGS_FILE);
}

/** board-settings.json as an object ({} when missing or unreadable). */
export function readBoardSettings(dataDir: string): Json {
  try {
    const s = JSON.parse(readFileSync(boardSettingsPath(dataDir), 'utf8'));
    return isObject(s) ? s : {};
  } catch {
    return {};
  }
}

/** Write board-settings.json whole, via a temp file + rename (a reader never sees half a file). */
export function writeBoardSettings(dataDir: string, content: Json): void {
  mkdirSync(dataDir, { recursive: true });
  const path = boardSettingsPath(dataDir);
  const tmp = join(dataDir, `.${BOARD_SETTINGS_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(content, null, 2));
  renameSync(tmp, path);
}

// ── one sync pass ───────────────────────────────────────────────────────────

export interface SyncResult {
  /** meta/settings as read (null: none yet, i.e. before the backfill; undefined: not readable). */
  settings: SettingsDoc | null | undefined;
  wroteFile: boolean;
  pushed: boolean;
  why: string;
}

/**
 * One pass: read meta/settings (unless `known` hands it in, e.g. from a
 * listener), reconcile with the file, write what changed. A store that can't
 * be read changes nothing (offline: the file keeps serving); no meta/settings
 * (before the backfill) changes nothing either.
 */
export async function syncSharedSettings(opts: {
  dataDir: string;
  store: Pick<DeviceStore, 'getSettings' | 'mergeSettings'>;
  known?: SettingsDoc | null;
  pendingStoreWrite?: () => boolean;
  log?: (msg: string) => void;
}): Promise<SyncResult> {
  let settings: SettingsDoc | null | undefined = opts.known;
  if (settings === undefined) {
    try {
      settings = await opts.store.getSettings();
    } catch (e) {
      opts.log?.(`settings: meta/settings not readable, keeping board-settings.json as it is (${(e as Error)?.message})`);
      return { settings: undefined, wroteFile: false, pushed: false, why: 'store not readable' };
    }
  }
  if (!settings) return { settings, wroteFile: false, pushed: false, why: 'no meta/settings' };
  const file = readBoardSettings(opts.dataDir);
  const r = reconcile(file, settings, { pendingStoreWrite: opts.pendingStoreWrite?.() ?? false });
  let wroteFile = false;
  let pushed = false;
  if (r.file) {
    writeBoardSettings(opts.dataDir, r.file);
    wroteFile = true;
  }
  if (r.storePatch) {
    try {
      await opts.store.mergeSettings(r.storePatch);
      pushed = true;
    } catch (e) {
      opts.log?.(`settings: local save not pushed to meta/settings (${(e as Error)?.message}); next pass retries`);
    }
  }
  if (wroteFile || pushed) opts.log?.(`settings: ${r.why}`);
  return { settings, wroteFile, pushed, why: r.why };
}

/** Whether the outbox holds a write to meta/settings (the newer local save has not reached the store). */
export function pendingSettingsWrite(entries: Array<{ entry: { path: string } }>): boolean {
  return entries.some((e) => e.entry.path === 'meta/settings');
}
