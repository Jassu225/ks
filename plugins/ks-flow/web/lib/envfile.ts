// lib/envfile.ts — SERVER-only .env loading for the board's API routes, one
// copy instead of one per route. <dataDir>/.env first (the real environment
// wins), then the shared KS store (Keychain + ~/.config/ks, lib/ksconfig.ts)
// for anything still missing, so tokens are set once for every KS plugin.
import { readFileSync } from 'node:fs';
import { expandHome, loadKsLayer } from './ksconfig';

export function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = expandHome(val);
  }
}

/** <dataDir>/.env, then the KS store. */
export function loadDataEnv(path: string): void {
  loadEnvFile(path);
  loadKsLayer();
}
