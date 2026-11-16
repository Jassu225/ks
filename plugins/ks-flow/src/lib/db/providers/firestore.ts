// lib/db/providers/firestore.ts — the v1 provider and the ONLY Firestore-aware
// module on the daemon side. Writer = firebase-admin. Source = firebase-admin
// onSnapshot. The browser board never talks to Firestore: its server streams
// the same collections to it (web/app/api/store/live).
//
// Collection tree: flat, at the top of the database. The GCP project holds
// one ks-flow board (KarmaSuite), so there is no per-project level; the
// `projectId` arguments are kept for the shared interface and ignored here.
//   meta/project            ← RETIRED by the device backfill (legacy daemons still write it)
//   meta/settings           ← shared settings + masterDeviceId (lib/db/devicestore.ts)
//   devices/{deviceId}      ← one per device (merge writes only)
//   masterRequests/{uid}    ← asks for the master device's daemon
//   workUnits/{unitId}      ← the cards
//   sessions/{sessionId}    ← JSONL-derived activity
//   reminders/{uid}
//   backupUnits/{uid}       ← what the GCS backup holds per unit
//   backupRuns/{uid}        ← one per backup sweep
//   briefingItems/{uid}     ← what the master found in Slack for the person
//   briefingRuns/{uid}      ← one per master pass over Slack
//   dailyLogs/{date}        ← log-in / log-off per local day
//   masterEvents/{uid}      ← master starts/restarts and requests sent to it
//   slack_names/{uid}       ← written by the board server (web/lib/serverdb.ts)
// The same database also holds other apps' collections (ks-works'
// `slack_user_tokens`): never list or delete at the database root.
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type Credential,
} from 'firebase-admin/app';
import {
  getFirestore,
  type Firestore,
  type CollectionReference,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
  type WriteBatch,
} from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, type Config } from '../../config.js';
import { Outbox, type DocStore, type StoreOp } from '../outbox.js';
import { docDeviceStore } from '../devicestore.js';
import { storeWriteBlock } from '../../versioning.js';
import type {
  BackupRunDoc,
  BackupStore,
  BackupUnitDoc,
  BriefingItemDoc,
  BriefingItemFilter,
  BriefingRunDoc,
  BriefingStore,
  DailyLogDoc,
  DbProvider,
  DeviceStore,
  DocDb,
  MasterEventDoc,
  ProjectDoc,
  ReminderDoc,
  SessionDoc,
  SessionSource,
  SessionWriter,
  Unsubscribe,
  WorkUnitDoc,
} from '../types.js';

const APP_NAME = 'ks-flow';
const MAX_BATCH = 500;

function getApp(cfg: Config): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;

  if (cfg.firestoreMode === 'emulator') {
    // firebase-admin honors FIRESTORE_EMULATOR_HOST automatically; just
    // ensure it is set so we never touch a real project by accident.
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    }
    return initializeApp(
      { projectId: cfg.gcpProjectId || 'ks-flow-emulator' },
      APP_NAME,
    );
  }

  // cloud
  if (!cfg.gcpProjectId) {
    throw new Error('firestore_mode=cloud requires a project id (gcp_project_id / FIREBASE_PROJECT_ID)');
  }
  return initializeApp(
    { credential: resolveCredential(cfg), projectId: cfg.gcpProjectId },
    APP_NAME,
  );
}

/**
 * Cloud credential resolution, env-first (no service-account file required):
 *   1. client-email + private-key env  (userConfig → CLAUDE_PLUGIN_OPTION_*,
 *      or raw FIREBASE_* for manual/foreground runs)
 *   2. firestore_credentials JSON file (optional fallback)
 *   3. Application Default Credentials  (honors GOOGLE_APPLICATION_CREDENTIALS)
 */
function resolveCredential(cfg: Config): Credential {
  if (cfg.firestoreClientEmail && cfg.firestorePrivateKey) {
    return cert({
      projectId: cfg.gcpProjectId,
      clientEmail: cfg.firestoreClientEmail,
      // env vars carry the key with literal "\n" escapes — restore real newlines
      privateKey: cfg.firestorePrivateKey.replace(/\\n/g, '\n'),
    });
  }
  if (cfg.firestoreCredentials) {
    return cert(JSON.parse(readFileSync(cfg.firestoreCredentials, 'utf8')));
  }
  return applicationDefault();
}

function db(cfg: Config): Firestore {
  return getFirestore(getApp(cfg));
}

function projectRef(fs: Firestore, _projectId: string) {
  return fs.collection('meta').doc('project');
}
function sessionsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('sessions');
}
function workUnitsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('workUnits');
}
function remindersCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('reminders');
}
function backupUnitsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('backupUnits');
}
function backupRunsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('backupRuns');
}

function briefingItemsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('briefingItems');
}
function briefingRunsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('briefingRuns');
}
function dailyLogsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('dailyLogs');
}
function masterEventsCol(fs: Firestore, _projectId: string): CollectionReference {
  return fs.collection('masterEvents');
}

/** A whole-doc set, without undefined fields. */
function setOp(ref: DocumentReference, doc: object): StoreOp {
  return { op: 'set', path: ref.path, data: plain(doc) as Record<string, unknown> };
}

/** The outbox's way into Firestore: one op directly, several in one batch. */
export function firestoreStore(fs: Firestore): DocStore {
  const one = (b: WriteBatch | null, o: StoreOp): Promise<unknown> | void => {
    const ref = fs.doc(o.path);
    const data = o.data ?? {};
    if (b) {
      if (o.op === 'delete') b.delete(ref);
      else if (o.op === 'merge') b.set(ref, data, { merge: true });
      else b.set(ref, data);
      return;
    }
    if (o.op === 'delete') return ref.delete();
    if (o.op === 'merge') return ref.set(data, { merge: true });
    return ref.set(data);
  };
  return {
    async apply(ops) {
      if (ops.length === 1) {
        await one(null, ops[0]);
        return;
      }
      const b = fs.batch();
      for (const o of ops) one(b, o);
      await b.commit();
    },
  };
}

/** Direct writes to this config's Firestore, bypassing the outbox (one-off
 * tools such as the PocketBase migration, which want errors to surface). */
export function directFirestoreStore(cfg: Config): DocStore {
  return firestoreStore(db(cfg));
}

/** Reads give up after this long. Offline (or right after the Mac wakes), a
 * firebase-admin read otherwise retries until its own deadline, seen at 15 min,
 * holding up the reminder and briefing jobs that wait on it. A timed-out read
 * throws like any failed read; the caller's next tick tries again. */
export const READ_TIMEOUT_MS = 15_000;

function timed<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`firestore read timed out after ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS);
    t.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** A listener that fails (permissions, network) stops for good; say so. */
function snapshotError(coll: string): (e: Error) => void {
  return (e) => console.error(`[ks-flow] firestore ${coll} listener stopped: ${e.message}`);
}

/** Firestore refuses `undefined` fields (optional ones left out); a JSON round-trip drops them. */
function plain<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}

/**
 * The backup CLI's store. Whole-doc `set`, not a merge: a unit's `sessions` map
 * loses entries the bucket no longer holds, and a merge would keep them.
 */
class FirestoreBackups implements BackupStore {
  private fs: Firestore;
  constructor(
    cfg: Config,
    private ob: Outbox,
  ) {
    this.fs = db(cfg);
  }

  async getBackupUnits(projectId: string): Promise<BackupUnitDoc[]> {
    const snap = await timed(backupUnitsCol(this.fs, projectId).get());
    return snap.docs.map((d) => d.data() as BackupUnitDoc);
  }

  async upsertBackupUnit(projectId: string, doc: BackupUnitDoc): Promise<void> {
    await this.ob.write([setOp(backupUnitsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }

  async getBackupRuns(projectId: string): Promise<BackupRunDoc[]> {
    const snap = await timed(backupRunsCol(this.fs, projectId).orderBy('startedAt', 'desc').get());
    return snap.docs.map((d) => d.data() as BackupRunDoc);
  }

  async upsertBackupRun(projectId: string, doc: BackupRunDoc): Promise<void> {
    await this.ob.write([setOp(backupRunsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }
}

/** The briefing store. Whole-doc `set`, like backups: a doc is always written
 * as read-modify-write of the full record. */
class FirestoreBriefing implements BriefingStore {
  private fs: Firestore;
  constructor(
    cfg: Config,
    private ob: Outbox,
  ) {
    this.fs = db(cfg);
  }

  async getBriefingItems(projectId: string, filter: BriefingItemFilter = {}): Promise<BriefingItemDoc[]> {
    let q: Query = briefingItemsCol(this.fs, projectId);
    if (filter.status) q = q.where('status', '==', filter.status);
    if (filter.groupKey) q = q.where('groupKey', '==', filter.groupKey);
    const snap = await timed(q.get());
    return snap.docs
      .map((d) => d.data() as BriefingItemDoc)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  async getBriefingItem(projectId: string, uid: string): Promise<BriefingItemDoc | null> {
    const snap = await timed(briefingItemsCol(this.fs, projectId).doc(uid).get());
    return snap.exists ? (snap.data() as BriefingItemDoc) : null;
  }

  async upsertBriefingItem(projectId: string, doc: BriefingItemDoc): Promise<void> {
    await this.ob.write([setOp(briefingItemsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }

  async getBriefingRuns(projectId: string): Promise<BriefingRunDoc[]> {
    const snap = await timed(briefingRunsCol(this.fs, projectId).orderBy('startedAt', 'desc').get());
    return snap.docs.map((d) => d.data() as BriefingRunDoc);
  }

  async getBriefingRun(projectId: string, uid: string): Promise<BriefingRunDoc | null> {
    const snap = await timed(briefingRunsCol(this.fs, projectId).doc(uid).get());
    return snap.exists ? (snap.data() as BriefingRunDoc) : null;
  }

  async upsertBriefingRun(projectId: string, doc: BriefingRunDoc): Promise<void> {
    await this.ob.write([setOp(briefingRunsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }

  async getDailyLog(projectId: string, date: string): Promise<DailyLogDoc | null> {
    const snap = await timed(dailyLogsCol(this.fs, projectId).doc(date).get());
    return snap.exists ? (snap.data() as DailyLogDoc) : null;
  }

  async getDailyLogs(projectId: string): Promise<DailyLogDoc[]> {
    const snap = await timed(dailyLogsCol(this.fs, projectId).orderBy('date', 'desc').get());
    return snap.docs.map((d) => d.data() as DailyLogDoc);
  }

  async upsertDailyLog(projectId: string, doc: DailyLogDoc): Promise<void> {
    await this.ob.write([setOp(dailyLogsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }

  async getMasterEvents(projectId: string, limit = 200): Promise<MasterEventDoc[]> {
    const snap = await timed(masterEventsCol(this.fs, projectId).orderBy('at', 'desc').limit(limit).get());
    return snap.docs.map((d) => d.data() as MasterEventDoc);
  }

  async upsertMasterEvent(projectId: string, doc: MasterEventDoc): Promise<void> {
    await this.ob.write([setOp(masterEventsCol(this.fs, projectId).doc(doc.uid), doc)]);
  }
}

/**
 * The daemon's writer. Whole-doc `set` like the stores above, matching the
 * PocketBase provider (its `data` column is replaced on every upsert): a merge
 * would keep fields the new doc no longer has (a cleared `dueAt`, keys dropped
 * from a card's `state`). Only `markArchived` merges, as it writes one field.
 */
class FirestoreWriter implements SessionWriter {
  private fs: Firestore;
  constructor(
    cfg: Config,
    private ob: Outbox,
  ) {
    this.fs = db(cfg);
  }

  async upsertSession(projectId: string, doc: SessionDoc): Promise<void> {
    await this.ob.write([setOp(sessionsCol(this.fs, projectId).doc(doc.sessionId), doc)]);
  }

  async upsertMany(projectId: string, docs: SessionDoc[]): Promise<void> {
    for (let i = 0; i < docs.length; i += MAX_BATCH) {
      await this.ob.write(
        docs.slice(i, i + MAX_BATCH).map((doc) => setOp(sessionsCol(this.fs, projectId).doc(doc.sessionId), doc)),
      );
    }
  }

  async upsertWorkUnit(projectId: string, doc: WorkUnitDoc): Promise<void> {
    await this.ob.write([setOp(workUnitsCol(this.fs, projectId).doc(doc.unitId), doc)]);
  }

  async upsertProject(doc: ProjectDoc): Promise<void> {
    await this.ob.write([setOp(projectRef(this.fs, doc.projectId), doc)]);
  }

  async markArchived(projectId: string, id: string): Promise<void> {
    await this.ob.write([
      { op: 'merge', path: sessionsCol(this.fs, projectId).doc(id).path, data: { archived: true } },
    ]);
  }

  async getReminders(projectId: string): Promise<ReminderDoc[]> {
    const snap = await timed(remindersCol(this.fs, projectId).get());
    return snap.docs.map((d) => d.data() as ReminderDoc);
  }

  async upsertReminder(projectId: string, doc: ReminderDoc): Promise<void> {
    await this.ob.write([setOp(remindersCol(this.fs, projectId).doc(doc.uid), doc)]);
  }

  async deleteReminder(projectId: string, uid: string): Promise<void> {
    await this.ob.write([{ op: 'delete', path: remindersCol(this.fs, projectId).doc(uid).path }]);
  }
}

class FirestoreSource implements SessionSource {
  private fs: Firestore;
  constructor(cfg: Config) {
    this.fs = db(cfg);
  }

  async getProject(projectId: string): Promise<ProjectDoc | null> {
    const snap = await timed(projectRef(this.fs, projectId).get());
    return snap.exists ? (snap.data() as ProjectDoc) : null;
  }

  async getWorkUnits(projectId: string): Promise<WorkUnitDoc[]> {
    const snap = await timed(workUnitsCol(this.fs, projectId).get());
    return snap.docs.map((d) => d.data() as WorkUnitDoc);
  }

  async getSessions(projectId: string): Promise<SessionDoc[]> {
    const snap = await timed(sessionsCol(this.fs, projectId)
      .where('inProject', '==', true)
      .get());
    return snap.docs.map((d) => d.data() as SessionDoc);
  }

  async getReminders(projectId: string): Promise<ReminderDoc[]> {
    const snap = await timed(remindersCol(this.fs, projectId).get());
    return snap.docs.map((d) => d.data() as ReminderDoc);
  }

  subscribeWorkUnits(
    projectId: string,
    onChange: (docs: WorkUnitDoc[]) => void,
  ): Unsubscribe {
    return workUnitsCol(this.fs, projectId).onSnapshot((snap) => {
      onChange(snap.docs.map((d) => d.data() as WorkUnitDoc));
    }, snapshotError('workUnits'));
  }

  subscribeReminders(
    projectId: string,
    onChange: (docs: ReminderDoc[]) => void,
  ): Unsubscribe {
    return remindersCol(this.fs, projectId).onSnapshot((snap) => {
      onChange(snap.docs.map((d) => d.data() as ReminderDoc));
    }, snapshotError('reminders'));
  }

  subscribeSessions(
    projectId: string,
    onChange: (docs: SessionDoc[]) => void,
  ): Unsubscribe {
    return sessionsCol(this.fs, projectId)
      .where('inProject', '==', true)
      .onSnapshot((snap) => {
        onChange(snap.docs.map((d) => d.data() as SessionDoc));
      }, snapshotError('sessions'));
  }
}

/** Firestore by path (lib/db/devicestore.ts, lib/device-backfill.ts). Reads
 * time out like every read here; `create` and the listener go direct; writes
 * go through the outbox. */
export function firestoreDocDb(fs: Firestore, ob: Outbox): DocDb {
  // The direct writes (create, transact) honour the outbox's write gate too.
  const blocked = (): boolean => !!ob.writeBlock();
  const rows = (docs: QueryDocumentSnapshot[]) =>
    docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  return {
    async get(path) {
      const snap = await timed(fs.doc(path).get());
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async list(coll, fields) {
      const c = fs.collection(coll);
      const snap = await timed((fields ? c.select(...fields) : c).get());
      return rows(snap.docs);
    },
    async create(path, data) {
      if (blocked()) throw new Error(`not written (${ob.writeBlock()})`);
      try {
        await timed(fs.doc(path).create(data));
        return true;
      } catch (e) {
        if ((e as { code?: unknown }).code === 6) return false; // ALREADY_EXISTS
        throw e;
      }
    },
    async write(ops) {
      await ob.write(ops);
    },
    async transact(path, fn) {
      if (blocked()) return null;
      const ref = fs.doc(path);
      return timed(
        fs.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const cur = snap.exists ? (snap.data() as Record<string, unknown>) : null;
          const patch = fn(cur);
          if (!patch) return null;
          tx.set(ref, patch, { merge: true });
          return { ...(cur ?? {}), ...patch };
        }),
      );
    },
    watch(coll, fields, onChange) {
      const c = fs.collection(coll);
      return (fields.length ? c.select(...fields) : c).onSnapshot((snap) => onChange(rows(snap.docs)), snapshotError(coll));
    },
    watchDoc(path, onChange) {
      return fs
        .doc(path)
        .onSnapshot((snap) => onChange(snap.exists ? (snap.data() as Record<string, unknown>) : null), snapshotError(path));
    },
  };
}

export function createFirestoreProvider(cfg: Config): DbProvider {
  let writer: FirestoreWriter | undefined;
  let source: FirestoreSource | undefined;
  let backups: FirestoreBackups | undefined;
  let briefing: FirestoreBriefing | undefined;
  let outbox: Outbox | undefined;
  let docs: DocDb | undefined;
  let devices: DeviceStore | undefined;
  // Offline mode (lib/db/outbox.ts): every write goes through the outbox.
  // The write gate: this device's status file (lib/versioning.ts), so every
  // process of this device drops its writes while it is behind on the data format.
  const ob = (): Outbox =>
    (outbox ??= new Outbox(join(dataDir(), 'outbox'), firestoreStore(db(cfg)), {
      blocked: () => storeWriteBlock(dataDir()),
    }));
  const docDb = (): DocDb => (docs ??= firestoreDocDb(db(cfg), ob()));
  return {
    name: 'firestore',
    writer: () => (writer ??= new FirestoreWriter(cfg, ob())),
    source: () => (source ??= new FirestoreSource(cfg)),
    backups: () => (backups ??= new FirestoreBackups(cfg, ob())),
    briefing: () => (briefing ??= new FirestoreBriefing(cfg, ob())),
    devices: () => (devices ??= docDeviceStore(docDb())),
    docDb,
    outbox: () => ob(),
  };
}
