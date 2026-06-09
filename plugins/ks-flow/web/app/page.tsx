// Server component: resolves board config at request time (no NEXT_PUBLIC
// build-baking) from project.conf + the CLAUDE_PLUGIN_OPTION_* environment the
// CLI passes to `next start`, then hands it to the client board.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Board } from '@/components/Board';
import type { BoardConfig } from '@/lib/types';

export const dynamic = 'force-dynamic';

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

function loadConfig(): BoardConfig {
  const dataDir =
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite');
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
    dbProvider,
    firestoreMode: mode === 'cloud' ? 'cloud' : 'emulator',
    gcpProjectId,
    firebase,
    pocketbaseUrl,
  };
}

export default function Page() {
  const config = loadConfig();
  if (!config.projectId) {
    return (
      <div className="grid h-screen place-items-center bg-slate-950 px-6 text-center text-sm text-slate-400">
        <div>
          <p>No project configured.</p>
          <p className="mt-1">
            Set one in{' '}
            <a href="/settings" className="text-indigo-400 underline hover:text-indigo-300">
              settings
            </a>
            , or run <code className="mx-1 rounded bg-slate-800 px-1">ks-flow set-project &lt;path&gt;</code>.
          </p>
        </div>
      </div>
    );
  }
  return <Board config={config} />;
}
