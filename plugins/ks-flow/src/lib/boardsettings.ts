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

// ── briefing (the master session's Slack passes) ─────────────────────────────
export interface BriefingSettings {
  /** Master switch: the daemon writes scheduled requests only when on. */
  enabled: boolean;
  /** Local times of day ('HH:MM') for a scheduled pass. */
  schedule: string[];
  /** Names that count as the person being written to (the user's name, anywhere). */
  names: string[];
  /** Slack user ids whose asks get half the usual window. */
  halfTime: string[];
  /** The person's own Slack user id, once known. */
  slackUserId: string | null;
}

const BRIEFING_DEFAULTS: BriefingSettings = {
  enabled: false,
  schedule: ['00:00', '06:00', '12:00', '18:00'],
  names: ['Jaswanth'],
  halfTime: [],
  slackUserId: null,
};

let cachedBriefing: BriefingSettings = BRIEFING_DEFAULTS;
let cachedBriefingMtime = -1;

/** Read the `briefing` block out of board-settings.json. Off until the person
 * turns it on: on, the daemon schedules passes of a long-running master session. */
export function briefingSettings(): BriefingSettings {
  const path = join(dataDir(), 'board-settings.json');
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    cachedBriefing = BRIEFING_DEFAULTS;
    cachedBriefingMtime = -1;
    return cachedBriefing;
  }
  if (mtime === cachedBriefingMtime) return cachedBriefing;
  cachedBriefingMtime = mtime;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    const b = (s.briefing ?? {}) as Partial<Record<keyof BriefingSettings, unknown>>;
    const strings = (v: unknown, dflt: string[], ok: (x: string) => boolean = () => true): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ok(x)) : dflt;
    const slot = (x: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
    cachedBriefing = {
      enabled: b.enabled === true,
      schedule: [...new Set(strings(b.schedule, BRIEFING_DEFAULTS.schedule, slot))].sort(),
      names: strings(b.names, BRIEFING_DEFAULTS.names, (x) => x.trim() !== ''),
      halfTime: strings(b.halfTime, BRIEFING_DEFAULTS.halfTime),
      slackUserId: typeof b.slackUserId === 'string' && b.slackUserId ? b.slackUserId : null,
    };
  } catch {
    cachedBriefing = BRIEFING_DEFAULTS;
  }
  return cachedBriefing;
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
