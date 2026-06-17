// lib/serverdb.ts — SERVER-side reminder writes (Next.js API routes only).
//
// The board's server is the writer for the `reminders` collection (the daemon
// reads + writes back). Provider is resolved the same way as app/page.tsx /
// src/lib/config.ts. PocketBase: the `pocketbase` SDK over the local REST URL.
// Firestore: firebase-admin (emulator honors FIRESTORE_EMULATOR_HOST; cloud
// uses a service-account, mirroring src/lib/db/providers/firestore.ts).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import type { ReminderDoc } from './types';

const REMINDERS = 'reminders';

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

interface ServerConfig {
  projectId: string;
  dbProvider: 'pocketbase' | 'firestore';
  pocketbaseUrl: string;
  firestoreMode: 'emulator' | 'cloud';
  gcpProjectId: string;
  clientEmail?: string;
  privateKey?: string;
  credentials?: string;
}

function serverConfig(): ServerConfig {
  const dataDir =
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite');
  loadEnvFile(join(dataDir, '.env'));
  let projectId = '';
  try {
    projectId = JSON.parse(readFileSync(join(dataDir, 'project.conf'), 'utf8')).projectId ?? '';
  } catch {
    /* not written yet */
  }
  const mode =
    (process.env.CLAUDE_PLUGIN_OPTION_firestore_mode as 'emulator' | 'cloud') ||
    (process.env.FIRESTORE_MODE as 'emulator' | 'cloud') ||
    'emulator';
  const rawGcp =
    process.env.CLAUDE_PLUGIN_OPTION_gcp_project_id || process.env.FIREBASE_PROJECT_ID;
  const explicit = process.env.CLAUDE_PLUGIN_OPTION_db_provider || process.env.DB_PROVIDER;
  const dbProvider: 'pocketbase' | 'firestore' =
    explicit === 'firestore' || explicit === 'pocketbase'
      ? explicit
      : mode === 'cloud' && rawGcp
        ? 'firestore'
        : 'pocketbase';
  const pbPort =
    process.env.CLAUDE_PLUGIN_OPTION_pocketbase_port || process.env.POCKETBASE_PORT || '8090';
  return {
    projectId,
    dbProvider,
    pocketbaseUrl: process.env.POCKETBASE_URL || `http://127.0.0.1:${pbPort}`,
    firestoreMode: mode === 'cloud' ? 'cloud' : 'emulator',
    gcpProjectId: rawGcp || 'ks-flow-emulator',
    clientEmail:
      process.env.CLAUDE_PLUGIN_OPTION_firestore_client_email || process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:
      process.env.CLAUDE_PLUGIN_OPTION_firestore_private_key || process.env.FIREBASE_PRIVATE_KEY,
    credentials: process.env.CLAUDE_PLUGIN_OPTION_firestore_credentials,
  };
}

export function getProjectId(): string {
  return serverConfig().projectId;
}

// ── PocketBase ────────────────────────────────────────────────────────────────
function pbClient(cfg: ServerConfig): PocketBase {
  const pb = new PocketBase(cfg.pocketbaseUrl);
  pb.autoCancellation(false);
  return pb;
}

async function pbUpsert(cfg: ServerConfig, doc: ReminderDoc): Promise<void> {
  const pb = pbClient(cfg);
  const body = { uid: doc.uid, projectKey: doc.projectId, unitKey: doc.unitId ?? '', data: doc };
  try {
    const rec = await pb.collection(REMINDERS).getFirstListItem(pb.filter('uid={:u}', { u: doc.uid }));
    await pb.collection(REMINDERS).update(rec.id, body);
  } catch {
    await pb.collection(REMINDERS).create(body);
  }
}

async function pbDelete(cfg: ServerConfig, uid: string): Promise<void> {
  const pb = pbClient(cfg);
  try {
    const rec = await pb.collection(REMINDERS).getFirstListItem(pb.filter('uid={:u}', { u: uid }));
    await pb.collection(REMINDERS).delete(rec.id);
  } catch {
    // already gone
  }
}

// ── Firestore (firebase-admin) ──────────────────────────────────────────────
async function fsCol(cfg: ServerConfig) {
  const { getApps, initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const APP = 'ks-flow-board';
  let app = getApps().find((a) => a.name === APP);
  if (!app) {
    if (cfg.firestoreMode === 'emulator') {
      if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
      app = initializeApp({ projectId: cfg.gcpProjectId }, APP);
    } else {
      const credential =
        cfg.clientEmail && cfg.privateKey
          ? cert({
              projectId: cfg.gcpProjectId,
              clientEmail: cfg.clientEmail,
              privateKey: cfg.privateKey.replace(/\\n/g, '\n'),
            })
          : cfg.credentials
            ? cert(JSON.parse(readFileSync(cfg.credentials, 'utf8')))
            : applicationDefault();
      app = initializeApp({ credential, projectId: cfg.gcpProjectId }, APP);
    }
  }
  return getFirestore(app).collection('projects').doc(cfg.projectId).collection(REMINDERS);
}

// ── public API ────────────────────────────────────────────────────────────────
export async function upsertReminder(doc: ReminderDoc): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbUpsert(cfg, doc);
  await (await fsCol(cfg)).doc(doc.uid).set(doc, { merge: true });
}

export async function deleteReminder(uid: string): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbDelete(cfg, uid);
  await (await fsCol(cfg)).doc(uid).delete();
}
