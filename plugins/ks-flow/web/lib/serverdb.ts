// lib/serverdb.ts — SERVER-side store writes (Next.js API routes only):
// reminders, briefing items, master events, the Slack names cache.
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
import type { BriefingItemDoc, MasterEventDoc, ReminderDoc } from './types';

const REMINDERS = 'reminders';
const SLACK_NAMES = 'slack_names';

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

async function pbList(cfg: ServerConfig): Promise<ReminderDoc[]> {
  const pb = pbClient(cfg);
  const recs = await pb
    .collection(REMINDERS)
    .getFullList({ filter: pb.filter('projectKey={:k}', { k: cfg.projectId }) });
  return recs.map((r) => r.data as ReminderDoc).filter(Boolean);
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
  return fsProjectCol(cfg, REMINDERS);
}

/** `projects/<projectId>/<name>` through the board's firebase-admin app. */
async function fsProjectCol(cfg: ServerConfig, name: string) {
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
  return getFirestore(app).collection('projects').doc(cfg.projectId).collection(name);
}

// ── briefing_items (docs/briefing.md): the board's due changes and archives ──
// PocketBase rows mirror key/groupKey/status/dueAt/archivedAt out of `data`
// (as src/lib/db/providers/pocketbase.ts); Firestore stores the doc itself
// under projects/<id>/briefingItems/<uid>.
const BRIEFING_ITEMS = 'briefing_items';
const FS_BRIEFING_ITEMS = 'briefingItems';
/** uids per PocketBase OR filter, so the request URL stays short. */
const PB_UID_CHUNK = 50;

/** The current project's briefing items with these uids (missing ones are
 * left out). One read per 50 uids (PocketBase), one batched read (Firestore). */
export async function getBriefingItems(uids: string[]): Promise<BriefingItemDoc[]> {
  const cfg = serverConfig();
  const unique = [...new Set(uids)];
  if (unique.length === 0) return [];
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    const out: BriefingItemDoc[] = [];
    for (let i = 0; i < unique.length; i += PB_UID_CHUNK) {
      const chunk = unique.slice(i, i + PB_UID_CHUNK);
      const params: Record<string, string> = { k: cfg.projectId };
      chunk.forEach((u, j) => (params[`u${j}`] = u));
      const any = chunk.map((_, j) => `uid={:u${j}}`).join(' || ');
      const recs = await pb
        .collection(BRIEFING_ITEMS)
        .getFullList({ filter: pb.filter(`projectKey={:k} && (${any})`, params) });
      for (const r of recs) if (r.data) out.push(r.data as BriefingItemDoc);
    }
    return out;
  }
  const col = await fsProjectCol(cfg, FS_BRIEFING_ITEMS);
  const snaps = await col.firestore.getAll(...unique.map((u) => col.doc(u)));
  return snaps.filter((s) => s.exists).map((s) => s.data() as BriefingItemDoc);
}

/** Write one briefing item back (it must exist: the board never creates items). */
export async function putBriefingItem(doc: BriefingItemDoc): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    const rec = await pb
      .collection(BRIEFING_ITEMS)
      .getFirstListItem(pb.filter('projectKey={:k} && uid={:u}', { k: cfg.projectId, u: doc.uid }));
    await pb.collection(BRIEFING_ITEMS).update(rec.id, {
      uid: doc.uid,
      projectKey: cfg.projectId,
      key: doc.key,
      groupKey: doc.groupKey,
      status: doc.status,
      dueAt: doc.dueAt,
      archivedAt: doc.archivedAt ?? '',
      data: doc,
    });
    return;
  }
  await (await fsProjectCol(cfg, FS_BRIEFING_ITEMS)).doc(doc.uid).set(doc);
}

// ── master_events: the board's own requests to the master (Activity Log) ────
// Same record shape as src/lib/db/providers/pocketbase.ts (uid, projectKey,
// mirrored `at`, data) / Firestore projects/<id>/masterEvents/<uid>.
const MASTER_EVENTS = 'master_events';
const FS_MASTER_EVENTS = 'masterEvents';

/** Record one master event. Firestore refuses undefined fields, so unset optional ones are dropped. */
export async function addMasterEvent(doc: MasterEventDoc): Promise<void> {
  const cfg = serverConfig();
  const plain = JSON.parse(JSON.stringify(doc)) as MasterEventDoc;
  if (cfg.dbProvider === 'pocketbase') {
    await pbClient(cfg)
      .collection(MASTER_EVENTS)
      .create({ uid: plain.uid, projectKey: cfg.projectId, at: plain.at, data: plain });
    return;
  }
  await (await fsProjectCol(cfg, FS_MASTER_EVENTS)).doc(plain.uid).set(plain);
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

/** All reminder docs for the current project (the Notes page filters to kind:'note'). */
export async function listReminders(): Promise<ReminderDoc[]> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbList(cfg);
  const snap = await (await fsCol(cfg)).get();
  return snap.docs.map((d) => d.data() as ReminderDoc);
}

// ── slack_names cache (workspace-global id→name: users U…, channels C…) ───────
async function fsSlackCol(cfg: ServerConfig) {
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
  return getFirestore(app).collection(SLACK_NAMES);
}

/** The full Slack id→name cache (users + channels). */
export async function getSlackNames(): Promise<Record<string, string>> {
  const cfg = serverConfig();
  const out: Record<string, string> = {};
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    const recs = await pb.collection(SLACK_NAMES).getFullList();
    for (const r of recs) if (r.uid && r.name) out[r.uid as string] = r.name as string;
    return out;
  }
  const snap = await (await fsSlackCol(cfg)).get();
  for (const d of snap.docs) {
    const v = d.data() as { uid?: string; name?: string };
    if (v.uid && v.name) out[v.uid] = v.name;
  }
  return out;
}

/** Upsert resolved Slack names into the cache. */
export async function putSlackNames(map: Record<string, string>): Promise<void> {
  const cfg = serverConfig();
  const entries = Object.entries(map).filter(([id, name]) => id && name);
  if (entries.length === 0) return;
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    for (const [uid, name] of entries) {
      try {
        const rec = await pb
          .collection(SLACK_NAMES)
          .getFirstListItem(pb.filter('uid={:u}', { u: uid }));
        await pb.collection(SLACK_NAMES).update(rec.id, { uid, name });
      } catch {
        await pb.collection(SLACK_NAMES).create({ uid, name });
      }
    }
    return;
  }
  const col = await fsSlackCol(cfg);
  await Promise.all(entries.map(([uid, name]) => col.doc(uid).set({ uid, name }, { merge: true })));
}
