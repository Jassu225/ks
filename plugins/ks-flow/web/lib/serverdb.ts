// lib/serverdb.ts — SERVER-side store writes (Next.js API routes only):
// reminders, briefing items, master events, the Slack names cache, and the
// device side: meta/settings (the shared settings), devices/{id}, masterRequests.
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
import { isNetworkError, outboxEntries, overlay, withTimeout, writeOrQueue, type StoreOp } from './outbox';
import { readScopeCache } from './storeCache';
import { deviceId } from './device';
import type { BriefingItemDoc, DeviceDoc, MasterEventDoc, MasterRequestDoc, ReminderDoc, SettingsDoc } from './types';
import { loadDataEnv } from '@/lib/envfile';

const REMINDERS = 'reminders';
const SLACK_NAMES = 'slack_names';

export interface ServerConfig {
  projectId: string;
  dataDir: string;
  dbProvider: 'pocketbase' | 'firestore';
  pocketbaseUrl: string;
  firestoreMode: 'emulator' | 'cloud';
  gcpProjectId: string;
  clientEmail?: string;
  privateKey?: string;
  credentials?: string;
}

export function serverConfig(): ServerConfig {
  const dataDir =
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite');
  loadDataEnv(join(dataDir, '.env'));
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
    dataDir,
    dbProvider,
    pocketbaseUrl: process.env.POCKETBASE_URL || `http://127.0.0.1:${pbPort}`,
    firestoreMode: mode === 'cloud' ? 'cloud' : 'emulator',
    gcpProjectId: rawGcp || 'ks-flow-emulator',
    clientEmail:
      process.env.CLAUDE_PLUGIN_OPTION_firestore_client_email || process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:
      process.env.CLAUDE_PLUGIN_OPTION_firestore_private_key || process.env.FIREBASE_PRIVATE_KEY,
    credentials:
      process.env.CLAUDE_PLUGIN_OPTION_firestore_credentials || process.env.FIRESTORE_CREDENTIALS,
  };
}

export function getProjectId(): string {
  return serverConfig().projectId;
}

// ── PocketBase ────────────────────────────────────────────────────────────────
export function pbClient(cfg: ServerConfig): PocketBase {
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
/** Firestore refuses `undefined` fields (optional ones left out); a JSON round-trip drops them. */
function plain<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}

/** `plain` as an outbox entry's data. */
export function plainData(doc: object): Record<string, unknown> {
  return plain(doc) as Record<string, unknown>;
}

/** The board server's firebase-admin Firestore (one app, `ks-flow-board`). Used by
 * the writes below and by the live stream (app/api/store/live). */
export async function adminFirestore(cfg: ServerConfig = serverConfig()) {
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
  return getFirestore(app);
}

async function fsCol(cfg: ServerConfig) {
  return fsProjectCol(cfg, REMINDERS);
}

/** Top-level collection `<name>` through the board's firebase-admin app. The
 * store is flat (one board per GCP project; see src/lib/db/providers/firestore.ts). */
async function fsProjectCol(cfg: ServerConfig, name: string) {
  return (await adminFirestore(cfg)).collection(name);
}

/** Offline mode (lib/outbox.ts): write through firebase-admin, or queue for
 * the daemon to sync. */
export async function fsWrite(cfg: ServerConfig, ops: StoreOp[]): Promise<void> {
  const fs = await adminFirestore(cfg);
  await writeOrQueue(cfg.dataDir, ops, async (list) => {
    if (list.length === 1) {
      const o = list[0];
      const ref = fs.doc(o.path);
      if (o.op === 'delete') await ref.delete();
      else if (o.op === 'merge') await ref.set(o.data ?? {}, { merge: true });
      else await ref.set(o.data ?? {});
      return;
    }
    const b = fs.batch();
    for (const o of list) {
      const ref = fs.doc(o.path);
      if (o.op === 'delete') b.delete(ref);
      else if (o.op === 'merge') b.set(ref, o.data ?? {}, { merge: true });
      else b.set(ref, o.data ?? {});
    }
    await b.commit();
  });
}

/** A collection's path: flat, at the database root (see src/lib/db/providers/firestore.ts). */
const projectPath = (_cfg: ServerConfig, name: string): string => name;

/** A Firestore read with the write timeout; on a network failure, `fallback()`
 * (the live stream's last snapshot plus the queued writes). */
export async function fsRead<T>(read: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await withTimeout(read());
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return fallback();
  }
}

// ── briefing_items (docs/briefing.md): the board's due changes and archives ──
// PocketBase rows mirror key/groupKey/status/dueAt/archivedAt out of `data`
// (as src/lib/db/providers/pocketbase.ts); Firestore stores the doc itself
// under briefingItems/<uid>.
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
  return fsRead(
    async () => {
      const snaps = await col.firestore.getAll(...unique.map((u) => col.doc(u)));
      return snaps.filter((s) => s.exists).map((s) => s.data() as BriefingItemDoc);
    },
    () => {
      const snaps = readScopeCache(cfg.dataDir, 'briefing')?.snaps ?? {};
      const cached = [...(snaps.recentItems ?? []), ...(snaps.openItems ?? [])] as BriefingItemDoc[];
      const all = overlay(cached, outboxEntries(cfg.dataDir), projectPath(cfg, FS_BRIEFING_ITEMS), (d) => d.uid);
      const want = new Set(unique);
      return all.filter((d) => want.has(d.uid));
    },
  );
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
  await fsWrite(cfg, [{ op: 'set', path: `${projectPath(cfg, FS_BRIEFING_ITEMS)}/${doc.uid}`, data: plainData(doc) }]);
}

// ── master_events: the board's own requests to the master (Activity Log) ────
// Same record shape as src/lib/db/providers/pocketbase.ts (uid, projectKey,
// mirrored `at`, data) / Firestore masterEvents/<uid>.
const MASTER_EVENTS = 'master_events';
const FS_MASTER_EVENTS = 'masterEvents';

/** Record one master event. Firestore refuses undefined fields, so unset optional ones are dropped. */
export async function addMasterEvent(doc: MasterEventDoc): Promise<void> {
  const cfg = serverConfig();
  // Stamped with this device (the Activity Log's Device column).
  const clean = plain({ ...doc, deviceId: doc.deviceId ?? deviceId(cfg.dataDir) });
  if (cfg.dbProvider === 'pocketbase') {
    await pbClient(cfg)
      .collection(MASTER_EVENTS)
      .create({ uid: clean.uid, projectKey: cfg.projectId, at: clean.at, data: clean });
    return;
  }
  await fsWrite(cfg, [
    { op: 'set', path: `${projectPath(cfg, FS_MASTER_EVENTS)}/${clean.uid}`, data: plainData(clean) },
  ]);
}

// ── public API ────────────────────────────────────────────────────────────────
export async function upsertReminder(doc: ReminderDoc): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbUpsert(cfg, doc);
  // Whole-doc set, as PocketBase replaces `data`: a merge would keep a cleared `dueAt`.
  await fsWrite(cfg, [{ op: 'set', path: `${projectPath(cfg, REMINDERS)}/${doc.uid}`, data: plainData(doc) }]);
}

export async function deleteReminder(uid: string): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbDelete(cfg, uid);
  await fsWrite(cfg, [{ op: 'delete', path: `${projectPath(cfg, REMINDERS)}/${uid}` }]);
}

/** All reminder docs for the current project (the Notes page filters to kind:'note'). */
export async function listReminders(): Promise<ReminderDoc[]> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') return pbList(cfg);
  const col = await fsCol(cfg);
  return fsRead(
    async () => (await col.get()).docs.map((d) => d.data() as ReminderDoc),
    () => {
      const cached = (readScopeCache(cfg.dataDir, 'board')?.snaps.reminders ?? []) as ReminderDoc[];
      return overlay(cached, outboxEntries(cfg.dataDir), projectPath(cfg, REMINDERS), (d) => d.uid);
    },
  );
}

// ── slack_names cache (workspace-global id→name: users U…, channels C…) ───────
async function fsSlackCol(cfg: ServerConfig) {
  return (await adminFirestore(cfg)).collection(SLACK_NAMES);
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
  const col = await fsSlackCol(cfg);
  // Offline: no names (they are only a display cache; raw ids still render).
  const docs = await fsRead(async () => (await col.get()).docs, () => []);
  for (const d of docs) {
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
  await fsWrite(
    cfg,
    entries.map(([uid, name]) => ({ op: 'set' as const, path: `${SLACK_NAMES}/${uid}`, data: { uid, name } })),
  );
}

// ── devices: meta/settings, devices/{id}, masterRequests ─────────────────────
// Same paths as src/lib/db/devicestore.ts (Firestore) and the PocketBase rows of
// pb_migrations/1700000007_devices.js (`meta` / `devices` keyed by `key`, the
// doc in `data`; `master_requests` by `uid`).
export const SETTINGS_PATH = 'meta/settings';
const FS_DEVICES = 'devices';
const FS_MASTER_REQUESTS = 'masterRequests';
const PB_META = 'meta';
const PB_DEVICES = 'devices';

/** The board-settings.json blocks every device shares (src/lib/device-backfill.ts SHARED_BLOCKS). */
export const SHARED_SETTINGS_BLOCKS = ['briefing', 'notes', 'reminders', 'gcsArchive', 'transcriptBackup'] as const;

async function pbRow(cfg: ServerConfig, col: string, key: string): Promise<Record<string, unknown> | null> {
  const pb = pbClient(cfg);
  try {
    const r = await pb.collection(col).getFirstListItem(pb.filter('key={:k}', { k: key }));
    return (r.data ?? null) as Record<string, unknown> | null;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** The board's last live snapshot of one board-scope key (the offline fallback). */
function cachedBoard(cfg: ServerConfig, key: string): Record<string, unknown>[] | null {
  const snaps = readScopeCache(cfg.dataDir, 'board')?.snaps;
  const v = snaps?.[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : null;
}

/**
 * meta/settings: the doc, null when there is none (before the device
 * backfill), undefined when it can't be told (offline with no snapshot).
 */
export async function getSettingsDoc(): Promise<SettingsDoc | null | undefined> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') {
    try {
      return (await pbRow(cfg, PB_META, 'settings')) as SettingsDoc | null;
    } catch {
      return undefined;
    }
  }
  const fs = await adminFirestore(cfg);
  return fsRead<SettingsDoc | null | undefined>(
    async () => {
      const snap = await fs.doc(SETTINGS_PATH).get();
      return snap.exists ? (snap.data() as SettingsDoc) : null;
    },
    () => {
      const cached = cachedBoard(cfg, 'settings');
      if (!cached) return undefined;
      return (cached[0] as unknown as SettingsDoc | undefined) ?? null;
    },
  ).catch(() => undefined);
}

/** Merge into meta/settings (Firestore; queued in the outbox when offline). */
export async function mergeSettingsDoc(patch: Partial<SettingsDoc>): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    const rec = await pb.collection(PB_META).getFirstListItem(pb.filter('key={:k}', { k: 'settings' }));
    await pb.collection(PB_META).update(rec.id, { data: { ...(rec.data ?? {}), ...plainData(patch) } });
    return;
  }
  await fsWrite(cfg, [{ op: 'merge', path: SETTINGS_PATH, data: plainData(patch) }]);
}

/** One device's doc (null when unknown); offline, from the board's last snapshot. */
export async function getDeviceDoc(deviceId: string): Promise<DeviceDoc | null> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') {
    const d = await pbRow(cfg, PB_DEVICES, deviceId).catch(() => null);
    return d ? ({ ...(d as unknown as DeviceDoc), deviceId }) : null;
  }
  const fs = await adminFirestore(cfg);
  return fsRead<DeviceDoc | null>(
    async () => {
      const snap = await fs.doc(`${FS_DEVICES}/${deviceId}`).get();
      return snap.exists ? ({ ...(snap.data() as DeviceDoc), deviceId }) : null;
    },
    () => {
      const d = cachedBoard(cfg, 'devices')?.find((x) => x.deviceId === deviceId);
      return d ? (d as unknown as DeviceDoc) : null;
    },
  );
}

/** Ask the master device's daemon for a start / run / restart (Firestore; queued when offline). */
export async function addMasterRequestDoc(doc: MasterRequestDoc): Promise<void> {
  const cfg = serverConfig();
  if (cfg.dbProvider === 'pocketbase') throw new Error('masterRequests are not used on PocketBase (one device)');
  await fsWrite(cfg, [{ op: 'set', path: `${FS_MASTER_REQUESTS}/${doc.uid}`, data: plainData(doc) }]);
}
