// lib/boardsettings.ts — read the board's reminder settings on the daemon side.
//
// The reminder ENABLE flag + stop-nudge interval + cap live in
// $CLAUDE_PLUGIN_DATA/board-settings.json (UI-editable; the reminder DATA lives
// in the DB). mtime-gated so the daemon picks up Settings changes without a
// restart, without re-reading the file every tick.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

export interface ReminderSettings {
  enabled: boolean;
  stopIntervalMin: number;
  capCount: number;
  // Seconds of true quiet (no main-agent AND no teammate/subagent transcript
  // activity) before the FIRST stop notice fires. Debounces the misfire where a
  // Stop hits at a main-turn boundary while teammates are still churning.
  debounceSec: number;
}

const DEFAULTS: ReminderSettings = {
  enabled: true,
  stopIntervalMin: 5,
  capCount: 12,
  debounceSec: 60,
};

let cached: ReminderSettings = DEFAULTS;
let cachedMtime = -1;

export function reminderSettings(): ReminderSettings {
  const path = join(dataDir(), 'board-settings.json');
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    cached = DEFAULTS; // no settings file → defaults (enabled)
    cachedMtime = -1;
    return cached;
  }
  if (mtime === cachedMtime) return cached;
  cachedMtime = mtime;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    const r = (s.reminders ?? {}) as Partial<ReminderSettings>;
    cached = {
      enabled: r.enabled !== false, // default ON
      stopIntervalMin:
        typeof r.stopIntervalMin === 'number' && r.stopIntervalMin > 0
          ? r.stopIntervalMin
          : DEFAULTS.stopIntervalMin,
      capCount:
        typeof r.capCount === 'number' && r.capCount > 0 ? r.capCount : DEFAULTS.capCount,
      debounceSec:
        typeof r.debounceSec === 'number' && r.debounceSec >= 0
          ? r.debounceSec
          : DEFAULTS.debounceSec,
    };
  } catch {
    cached = DEFAULTS;
  }
  return cached;
}

// ── transcript backup (end-of-day sweep) ─────────────────────────────────────
export interface BackupSettings {
  /** Master switch for the daily sweep. Still requires gcsArchive.enabled. */
  enabled: boolean;
  /** Local time of day to run, 24h. */
  hour: number;
  minute: number;
  /** Narrows only the TRIGGER ("did anything happen lately"), never which files
   * are uploaded. 0 = no window: visit every unit and upload whatever is missing
   * from the bucket, which is what keeps old sessions from being lost. */
  sinceHours: number;
}

const BACKUP_DEFAULTS: BackupSettings = {
  enabled: true,
  hour: 23,
  minute: 45,
  sinceHours: 0,
};

let cachedBackup: BackupSettings = BACKUP_DEFAULTS;
let cachedBackupMtime = -1;

/** Read the `transcriptBackup` block out of board-settings.json. Defaults ON:
 * the feature is already gated by the opt-in `gcsArchive.enabled`, so a user who
 * turned archiving on wants their transcripts kept. */
export function backupSettings(): BackupSettings {
  const path = join(dataDir(), 'board-settings.json');
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    cachedBackup = BACKUP_DEFAULTS;
    cachedBackupMtime = -1;
    return cachedBackup;
  }
  if (mtime === cachedBackupMtime) return cachedBackup;
  cachedBackupMtime = mtime;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    const b = (s.transcriptBackup ?? {}) as Partial<BackupSettings>;
    const int = (v: unknown, dflt: number, min: number, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : dflt;
    cachedBackup = {
      enabled: b.enabled !== false,
      hour: int(b.hour, BACKUP_DEFAULTS.hour, 0, 23),
      minute: int(b.minute, BACKUP_DEFAULTS.minute, 0, 59),
      sinceHours: int(b.sinceHours, BACKUP_DEFAULTS.sinceHours, 0, 24 * 30),
    };
  } catch {
    cachedBackup = BACKUP_DEFAULTS;
  }
  return cachedBackup;
}
