// lib/config.ts — resolves plugin configuration from the environment and
// the persisted project.conf. userConfig values are exported to plugin
// subprocesses as CLAUDE_PLUGIN_OPTION_<KEY> (see plugins-reference).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './datadir.mjs';
import { loadEnvFile } from './envfile.js';

function opt(key: string): string | undefined {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  return v === undefined || v === '' ? undefined : v;
}

function num(key: string, dflt: number): number {
  const v = opt(key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * The plugin data dir, resolved by the shared single-source-of-truth module
 * (src/lib/datadir.mjs): $KS_FLOW_DATA → derived → $CLAUDE_PLUGIN_DATA → legacy.
 * The daemon is launched by the launchd plist with CLAUDE_PLUGIN_DATA already
 * set to the derived dir, so no cwd is needed here.
 */
export function dataDir(): string {
  return resolveDataDir();
}

export interface ProjectConf {
  projectPath: string;
  commonDir: string;
  projectId: string;
  worktreePaths: string[];
}

/** project.conf is written by bootstrap.sh / `ks-flow set-project`. */
export function readProjectConf(): ProjectConf | null {
  try {
    const raw = readFileSync(join(dataDir(), 'project.conf'), 'utf8');
    const conf = JSON.parse(raw) as Partial<ProjectConf>;
    if (!conf.projectPath || !conf.commonDir || !conf.projectId) return null;
    return {
      projectPath: conf.projectPath,
      commonDir: conf.commonDir,
      projectId: conf.projectId,
      worktreePaths: conf.worktreePaths ?? [],
    };
  } catch {
    return null;
  }
}

export interface Config {
  projectPath: string | undefined;
  workflowUser: string | undefined;
  dbProvider: string;
  firestoreMode: 'emulator' | 'cloud';
  gcpProjectId: string | undefined;
  firestoreClientEmail: string | undefined;
  firestorePrivateKey: string | undefined;
  firestoreCredentials: string | undefined;
  pocketbasePort: number;
  pocketbaseUrl: string;
  idleMinutes: number;
  notifyThrottleSec: number;
  boardPort: number;
}

/**
 * Provider auto-selection. An explicit `db_provider` always wins. Otherwise we
 * pick `firestore` only when a real cloud project is configured, and fall back
 * to `pocketbase` — the zero-config local default (no GCP, no emulator, no
 * creds). Both the daemon and the board compute this from the SAME signals
 * (db_provider / firestore_mode / gcp_project_id) so they never disagree.
 */
function resolveDbProvider(
  mode: 'emulator' | 'cloud',
  gcpProjectId: string | undefined,
): string {
  const explicit = opt('db_provider') ?? process.env.DB_PROVIDER;
  if (explicit) return explicit;
  if (mode === 'cloud' && gcpProjectId) return 'firestore';
  return 'pocketbase';
}

let envFileLoaded = false;

export function loadConfig(): Config {
  // Pull in $CLAUDE_PLUGIN_DATA/.env once (real env still wins).
  if (!envFileLoaded) {
    loadEnvFile(join(dataDir(), '.env'));
    envFileLoaded = true;
  }
  const mode = (opt('firestore_mode') ?? process.env.FIRESTORE_MODE ?? 'emulator') as
    | 'emulator'
    | 'cloud';
  const firestoreMode = mode === 'cloud' ? 'cloud' : 'emulator';
  // gcp_project_id (userConfig) with a raw-env fallback for manual runs
  const gcpProjectId = opt('gcp_project_id') ?? process.env.FIREBASE_PROJECT_ID;
  const pocketbasePort = num('pocketbase_port', 8090);
  return {
    projectPath: opt('project_path'),
    workflowUser: opt('workflow_user'),
    dbProvider: resolveDbProvider(firestoreMode, gcpProjectId),
    firestoreMode,
    gcpProjectId,
    firestoreClientEmail: opt('firestore_client_email') ?? process.env.FIREBASE_CLIENT_EMAIL,
    firestorePrivateKey: opt('firestore_private_key') ?? process.env.FIREBASE_PRIVATE_KEY,
    firestoreCredentials: opt('firestore_credentials'),
    pocketbasePort,
    pocketbaseUrl:
      process.env.POCKETBASE_URL ?? `http://127.0.0.1:${pocketbasePort}`,
    idleMinutes: num('idle_minutes', 30),
    notifyThrottleSec: num('notify_throttle_sec', 20),
    boardPort: num('board_port', 4317),
  };
}
