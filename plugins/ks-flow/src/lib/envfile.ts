// lib/envfile.ts — minimal .env loader (no dependency).
//
// The always-on launchd daemon does NOT inherit your shell environment, so a
// secret exported in ~/.zshrc never reaches it. Instead the daemon reads one
// file it can always find: $CLAUDE_PLUGIN_DATA/.env. Values already
// present in the real environment win (so userConfig / launchd plist override
// the file). Supports KEY=VALUE, optional quotes, and # comments.
import { readFileSync } from 'node:fs';

export function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no file → nothing to load
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // real env wins
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
