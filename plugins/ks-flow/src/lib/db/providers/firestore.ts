// lib/db/providers/firestore.ts — the v1 provider and the ONLY Firestore-aware
// module on the daemon side. Writer = firebase-admin. Source = firebase-admin
// onSnapshot (usable server-side, e.g. `ks-flow status` / an SSE fallback);
// the browser board ships its own client-SDK source under web/.
//
// Collection tree (scoped per project so cross-project data never mixes):
//   projects/{projectId}
//     ├─ workUnits/{unitId}   ← the cards
//     └─ sessions/{sessionId} ← JSONL-derived activity
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
} from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import type { Config } from '../../config.js';
import type {
  DbProvider,
  ProjectDoc,
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

function projectRef(fs: Firestore, projectId: string) {
  return fs.collection('projects').doc(projectId);
}
function sessionsCol(fs: Firestore, projectId: string): CollectionReference {
  return projectRef(fs, projectId).collection('sessions');
}
function workUnitsCol(fs: Firestore, projectId: string): CollectionReference {
  return projectRef(fs, projectId).collection('workUnits');
}

class FirestoreWriter implements SessionWriter {
  private fs: Firestore;
  constructor(cfg: Config) {
    this.fs = db(cfg);
  }

  async upsertSession(projectId: string, doc: SessionDoc): Promise<void> {
    await sessionsCol(this.fs, projectId)
      .doc(doc.sessionId)
      .set(doc, { merge: true });
  }

  async upsertMany(projectId: string, docs: SessionDoc[]): Promise<void> {
    for (let i = 0; i < docs.length; i += MAX_BATCH) {
      const batch = this.fs.batch();
      for (const doc of docs.slice(i, i + MAX_BATCH)) {
        batch.set(sessionsCol(this.fs, projectId).doc(doc.sessionId), doc, {
          merge: true,
        });
      }
      await batch.commit();
    }
  }

  async upsertWorkUnit(projectId: string, doc: WorkUnitDoc): Promise<void> {
    await workUnitsCol(this.fs, projectId)
      .doc(doc.unitId)
      .set(doc, { merge: true });
  }

  async upsertProject(doc: ProjectDoc): Promise<void> {
    await projectRef(this.fs, doc.projectId).set(doc, { merge: true });
  }

  async markArchived(projectId: string, id: string): Promise<void> {
    await sessionsCol(this.fs, projectId)
      .doc(id)
      .set({ archived: true }, { merge: true });
  }
}

class FirestoreSource implements SessionSource {
  private fs: Firestore;
  constructor(cfg: Config) {
    this.fs = db(cfg);
  }

  async getProject(projectId: string): Promise<ProjectDoc | null> {
    const snap = await projectRef(this.fs, projectId).get();
    return snap.exists ? (snap.data() as ProjectDoc) : null;
  }

  async getWorkUnits(projectId: string): Promise<WorkUnitDoc[]> {
    const snap = await workUnitsCol(this.fs, projectId).get();
    return snap.docs.map((d) => d.data() as WorkUnitDoc);
  }

  async getSessions(projectId: string): Promise<SessionDoc[]> {
    const snap = await sessionsCol(this.fs, projectId)
      .where('inProject', '==', true)
      .get();
    return snap.docs.map((d) => d.data() as SessionDoc);
  }

  subscribeWorkUnits(
    projectId: string,
    onChange: (docs: WorkUnitDoc[]) => void,
  ): Unsubscribe {
    return workUnitsCol(this.fs, projectId).onSnapshot((snap) => {
      onChange(snap.docs.map((d) => d.data() as WorkUnitDoc));
    });
  }

  subscribeSessions(
    projectId: string,
    onChange: (docs: SessionDoc[]) => void,
  ): Unsubscribe {
    return sessionsCol(this.fs, projectId)
      .where('inProject', '==', true)
      .onSnapshot((snap) => {
        onChange(snap.docs.map((d) => d.data() as SessionDoc));
      });
  }
}

export function createFirestoreProvider(cfg: Config): DbProvider {
  let writer: FirestoreWriter | undefined;
  let source: FirestoreSource | undefined;
  return {
    name: 'firestore',
    writer: () => (writer ??= new FirestoreWriter(cfg)),
    source: () => (source ??= new FirestoreSource(cfg)),
  };
}
