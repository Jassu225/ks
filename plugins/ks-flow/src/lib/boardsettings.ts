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
