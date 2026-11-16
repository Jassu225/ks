import dotenv from 'dotenv';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the scripts/ directory. Built, this file is dist/lib/env.js,
 * one level deeper, so step out of dist/ too: .env and the shell scripts live
 * beside the sources, not in the build.
 */
const parent = path.resolve(__dirname, '..');
export const SCRIPTS_DIR = path.basename(parent) === 'dist' ? path.dirname(parent) : parent;

/** Absolute path to the plugin root (plugins/ks/) */
export const PLUGIN_DIR = path.resolve(SCRIPTS_DIR, '..');

/** One known config key (lib/ks-config-keys.txt). */
export interface KsKey {
  namespace: string;
  key: string;
  secret: boolean;
}

/** The key list shared with lib/ks-config.sh and the ks-config CLI. */
export function readKeys(file = path.join(SCRIPTS_DIR, 'lib', 'ks-config-keys.txt')): KsKey[] {
  const out: KsKey[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [namespace, key, kind] = line.trim().split(/\s+/);
    if (namespace && key && kind) out.push({ namespace, key, secret: kind === 'secret' });
  }
  return out;
}

/** KEY=VALUE pairs of a file (quotes stripped, `export` allowed); {} when missing. */
export function parseEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  return dotenv.parse(raw.replace(/^\s*export\s+/gm, ''));
}

export interface StoreOptions {
  /** Default: $KS_CONFIG_DIR, else ~/.config/ks. */
  configDir?: string;
  /** Default: $KS_SECURITY_BIN, else /usr/bin/security. */
  securityBin?: string;
  keys?: KsKey[];
}

/** A secret from the Keychain (service ks.<namespace>, account <KEY>), or undefined. */
export function keychainValue(ns: string, key: string, securityBin: string): string | undefined {
  try {
    const v = execFileSync(securityBin, ['find-generic-password', '-s', `ks.${ns}`, '-a', key, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).replace(/\n$/, '');
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The KS store's values for every known key that is NOT already in `env`:
 * secrets from the Keychain, plain values from <configDir>/<ns>.env.
 */
export function storeValues(env: NodeJS.ProcessEnv, opts: StoreOptions = {}): Record<string, string> {
  const configDir = opts.configDir ?? process.env.KS_CONFIG_DIR ?? path.join(homedir(), '.config', 'ks');
  const securityBin = opts.securityBin ?? process.env.KS_SECURITY_BIN ?? '/usr/bin/security';
  const keys = opts.keys ?? readKeys();
  const files = new Map<string, Record<string, string>>();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (env[k.key] !== undefined && env[k.key] !== '') continue;
    let v: string | undefined;
    if (k.secret) {
      v = keychainValue(k.namespace, k.key, securityBin);
    } else {
      if (!files.has(k.namespace)) files.set(k.namespace, parseEnvFile(path.join(configDir, `${k.namespace}.env`)));
      v = files.get(k.namespace)![k.key] || undefined;
    }
    if (v !== undefined) out[k.key] = v;
  }
  return out;
}

/**
 * Load the config every CLI needs, in the shared lookup order:
 *   1. the real environment
 *   2. the KS store: Keychain secrets and ~/.config/ks/<ns>.env (see ks-config)
 *   3. the legacy files scripts/.env and the plugin's .config (read only)
 */
export function loadEnv(): void {
  try {
    Object.assign(process.env, storeValues(process.env));
  } catch {
    // No key list or no store: the legacy files below still apply.
  }
  dotenv.config({
    path: [
      path.join(SCRIPTS_DIR, '.env'),
      path.join(PLUGIN_DIR, '.config'),
    ],
    // Without this, dotenv v17 prints an "injecting env" banner to STDOUT,
    // which corrupts every `--json` output when piped into jq.
    quiet: true,
  });
}

/**
 * Return to the directory the CLI was invoked from. The `linear`, `slack` and
 * `grain` wrappers cd into scripts/ so `npx tsx` resolves, and pass the caller's
 * directory as KS_ORIGINAL_DIR; without this, relative paths (`--content-file
 * doc.md`, `-f shot.png`, `-o out.mp4`) resolved against scripts/ instead.
 */
export function restoreCallerCwd(): void {
  const dir = process.env.KS_ORIGINAL_DIR;
  if (!dir) return;
  try {
    process.chdir(dir);
  } catch {
    // The caller's directory is gone; relative paths fall back to scripts/.
  }
}
