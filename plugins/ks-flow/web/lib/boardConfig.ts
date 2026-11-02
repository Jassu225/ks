// lib/boardConfig.ts — SERVER-only: resolves the board config at request time
// (no NEXT_PUBLIC build-baking) from project.conf + the CLAUDE_PLUGIN_OPTION_*
// environment the CLI passes to `next start`. Used by the root layout (which
// hands it to every page's shared data provider) and by app/page.tsx.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoardConfig } from './types';

/** The data dir this board reads. The launcher (bin/ks-flow open) pins
 * CLAUDE_PLUGIN_DATA to the derived dir; KS_FLOW_DATA overrides. See
 * src/lib/datadir.mjs (shared source of truth). */
export function boardDataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

// Pull $CLAUDE_PLUGIN_DATA/.env into process.env (real env wins), so the
// board reads the same file the daemon does. Mirrors src/lib/envfile.ts.
function loadEnvFile(path: string): void {
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
    process.env[key] = val;
  }
}

export function loadBoardConfig(): BoardConfig {
  const dataDir = boardDataDir();
  loadEnvFile(join(dataDir, '.env'));
  let projectId = '';
  let projectPath = '';
  try {
    const conf = JSON.parse(readFileSync(join(dataDir, 'project.conf'), 'utf8'));
    projectId = conf.projectId ?? '';
    projectPath = conf.projectPath ?? '';
  } catch {
    /* project.conf not written yet */
  }
  const mode =
    (process.env.CLAUDE_PLUGIN_OPTION_firestore_mode as 'emulator' | 'cloud') ||
    (process.env.FIRESTORE_MODE as 'emulator' | 'cloud') ||
    'emulator';
  const rawGcp =
    process.env.CLAUDE_PLUGIN_OPTION_gcp_project_id || process.env.FIREBASE_PROJECT_ID;
  const gcpProjectId = rawGcp || 'ks-flow-emulator';

  // Provider auto-selection — MUST match src/lib/config.ts resolveDbProvider so
  // the board reads from whatever the daemon is writing to.
  const explicitProvider =
    process.env.CLAUDE_PLUGIN_OPTION_db_provider || process.env.DB_PROVIDER;
  const dbProvider: 'pocketbase' | 'firestore' =
    explicitProvider === 'firestore' || explicitProvider === 'pocketbase'
      ? explicitProvider
      : mode === 'cloud' && rawGcp
        ? 'firestore'
        : 'pocketbase';
  const pbPort =
    process.env.CLAUDE_PLUGIN_OPTION_pocketbase_port || process.env.POCKETBASE_PORT || '8090';
  const pocketbaseUrl = process.env.POCKETBASE_URL || `http://127.0.0.1:${pbPort}`;

  // Build the client config from discrete env vars, reusing the project id and
  // deriving authDomain/storageBucket from it (Firebase's own defaults).
  const env = (k: string) =>
    process.env[`CLAUDE_PLUGIN_OPTION_firebase_${k.toLowerCase()}`] ||
    process.env[`FIREBASE_${k}`];
  const apiKey = env('API_KEY');
  const firebase =
    mode === 'cloud' && apiKey
      ? {
          apiKey,
          projectId: gcpProjectId,
          authDomain: env('AUTH_DOMAIN') || `${gcpProjectId}.firebaseapp.com`,
          appId: env('APP_ID') || undefined,
          storageBucket: env('STORAGE_BUCKET') || `${gcpProjectId}.appspot.com`,
          messagingSenderId: env('MESSAGING_SENDER_ID') || undefined,
        }
      : null;

  return {
    projectId,
    projectPath,
    dataDir,
    dbProvider,
    firestoreMode: mode === 'cloud' ? 'cloud' : 'emulator',
    gcpProjectId,
    firebase,
    pocketbaseUrl,
  };
}
