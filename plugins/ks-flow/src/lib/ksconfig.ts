// lib/ksconfig.ts — the shared KS config store, as ks-flow reads it.
//
// Tokens and machine settings live once for every KS plugin (see the ks
// plugin's `ks-config`): secrets in the macOS Keychain (service ks.<namespace>,
// account <KEY>), plain values in ${KS_CONFIG_DIR:-~/.config/ks}/<ns>.env.
// ks-flow's per-project <dataDir>/.env still wins (store settings, overrides),
// and the real environment beats both. Only the keys ks-flow consumes are
// listed here; the full list is the ks plugin's scripts/lib/ks-config-keys.txt.
// web/lib/ksconfig.ts is the board server's copy (web can't import src/).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KsKey {
  namespace: string;
  key: string;
  secret: boolean;
}

export const KSFLOW_KEYS: KsKey[] = [
  { namespace: 'slack', key: 'SLACK_TOKEN', secret: true },
  { namespace: 'linear', key: 'LINEAR_API_KEY', secret: true },
  { namespace: 'gcs', key: 'GCS_BUCKET', secret: false },
  { namespace: 'gcs', key: 'GCS_PROJECT_ID', secret: false },
  { namespace: 'gcs', key: 'GCS_CREDENTIALS', secret: false },
  { namespace: 'gcs', key: 'GCS_CLIENT_EMAIL', secret: false },
  { namespace: 'gcs', key: 'GCS_PRIVATE_KEY', secret: true },
  { namespace: 'ks', key: 'KS_PROJECT_ROOT_PATH', secret: false },
];

function parseFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim().replace(/^export\s+/, '');
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

function keychain(ns: string, key: string, bin: string): string | undefined {
  try {
    const v = execFileSync(bin, ['find-generic-password', '-s', `ks.${ns}`, '-a', key, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).replace(/\n$/, '');
    return v || undefined;
  } catch {
    return undefined;
  }
}

export interface StoreOptions {
  configDir?: string;
  securityBin?: string;
  keys?: KsKey[];
}

/** Store values for the listed keys that `env` doesn't already have. */
export function storeValues(env: NodeJS.ProcessEnv, opts: StoreOptions = {}): Record<string, string> {
  const dir = opts.configDir ?? process.env.KS_CONFIG_DIR ?? join(homedir(), '.config', 'ks');
  const bin = opts.securityBin ?? process.env.KS_SECURITY_BIN ?? '/usr/bin/security';
  const files = new Map<string, Record<string, string>>();
  const out: Record<string, string> = {};
  for (const k of opts.keys ?? KSFLOW_KEYS) {
    if (env[k.key]) continue;
    let v: string | undefined;
    if (k.secret) v = keychain(k.namespace, k.key, bin);
    else {
      if (!files.has(k.namespace)) files.set(k.namespace, parseFile(join(dir, `${k.namespace}.env`)));
      v = files.get(k.namespace)![k.key] || undefined;
    }
    if (v !== undefined) out[k.key] = v;
  }
  return out;
}

let loaded = false;

/** Fill the KS store's values into process.env once per process (real env and
 * anything already loaded, e.g. <dataDir>/.env, win). A change needs a restart. */
export function loadKsLayer(): void {
  if (loaded) return;
  loaded = true;
  try {
    Object.assign(process.env, storeValues(process.env));
  } catch {
    // no store: nothing to add
  }
}
