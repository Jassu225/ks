// lib/db/providers/pocketbase.ts — the local default provider, and the ONLY
// PocketBase-aware module on the daemon side. PocketBase is a single local
// binary (SQLite inside) exposing a REST API + realtime SSE — effectively a
// zero-config local Firestore. The daemon writes over REST; the browser board
// ships its own PocketBase client under web/ and subscribes for realtime.
//
// Storage model: one collection per doc kind (projects / work_units /
// sessions). The full provider-agnostic doc lives in the `data` json field;
// `key` is our own id (projectId / unitId / sessionId), uniquely indexed so we
// can upsert. `projectKey` + `inProject` mirror two fields out of `data` purely
// so the board can filter server-side. Schema is provisioned by pb_migrations.
import PocketBase from 'pocketbase';
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

const PROJECTS = 'projects';
const WORK_UNITS = 'work_units';
const SESSIONS = 'sessions';

function statusOf(e: unknown): number {
  return (e as { status?: number } | null)?.status ?? 0;
}

function client(cfg: Config): PocketBase {
  const pb = new PocketBase(cfg.pocketbaseUrl);
  // The daemon is long-lived and fires overlapping requests; PocketBase's SDK
  // auto-cancels same-key in-flight requests by default, which would abort our
  // upserts. Disable it.
  pb.autoCancellation(false);
  return pb;
}

class PocketbaseWriter implements SessionWriter {
  private pb: PocketBase;
  // key → PocketBase record id, so steady-state upserts are a single PATCH.
  private ids = new Map<string, string>();
  constructor(cfg: Config) {
    this.pb = client(cfg);
  }

  /** Insert-or-update a record identified by our own `key`. Mirrors the
   * merge semantics of the other providers: only the supplied fields change. */
  private async upsert(
    col: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const cacheKey = `${col}:${key}`;
    let id = this.ids.get(cacheKey);
    if (!id) {
      try {
        const rec = await this.pb
          .collection(col)
          .getFirstListItem(this.pb.filter('key={:k}', { k: key }));
        id = rec.id;
        this.ids.set(cacheKey, id);
      } catch {
        // 404 → falls through to create
      }
    }
    if (id) {
      try {
        await this.pb.collection(col).update(id, body);
        return;
      } catch (e) {
        if (statusOf(e) === 404) this.ids.delete(cacheKey);
        else throw e;
      }
    }
    const rec = await this.pb.collection(col).create({ key, ...body });
    this.ids.set(cacheKey, rec.id);
  }

  async upsertSession(projectId: string, doc: SessionDoc): Promise<void> {
    await this.upsert(SESSIONS, doc.sessionId, {
      projectKey: projectId,
      inProject: doc.inProject,
      archived: doc.archived,
      data: doc,
    });
  }

  async upsertMany(projectId: string, docs: SessionDoc[]): Promise<void> {
    for (const doc of docs) await this.upsertSession(projectId, doc);
  }

  async upsertWorkUnit(projectId: string, doc: WorkUnitDoc): Promise<void> {
    await this.upsert(WORK_UNITS, doc.unitId, { projectKey: projectId, data: doc });
  }

  async upsertProject(doc: ProjectDoc): Promise<void> {
    await this.upsert(PROJECTS, doc.projectId, { projectKey: doc.projectId, data: doc });
  }

  async markArchived(projectId: string, id: string): Promise<void> {
    // Merge archived=true; leaves `data` untouched if the record exists.
    await this.upsert(SESSIONS, id, { projectKey: projectId, archived: true });
  }
}

class PocketbaseSource implements SessionSource {
  private pb: PocketBase;
  constructor(cfg: Config) {
    this.pb = client(cfg);
  }

  async getProject(projectId: string): Promise<ProjectDoc | null> {
    try {
      const rec = await this.pb
        .collection(PROJECTS)
        .getFirstListItem(this.pb.filter('key={:k}', { k: projectId }));
      return rec.data as ProjectDoc;
    } catch {
      return null;
    }
  }

  async getWorkUnits(projectId: string): Promise<WorkUnitDoc[]> {
    const recs = await this.pb
      .collection(WORK_UNITS)
      .getFullList({ filter: this.pb.filter('projectKey={:k}', { k: projectId }) });
    return recs.map((r) => r.data as WorkUnitDoc);
  }

  async getSessions(projectId: string): Promise<SessionDoc[]> {
    const recs = await this.pb.collection(SESSIONS).getFullList({
      filter: this.pb.filter('projectKey={:k} && inProject=true', { k: projectId }),
    });
    return recs.map((r) => r.data as SessionDoc);
  }

  subscribeWorkUnits(
    projectId: string,
    onChange: (docs: WorkUnitDoc[]) => void,
  ): Unsubscribe {
    return this.poll(WORK_UNITS, this.pb.filter('projectKey={:k}', { k: projectId }), () =>
      this.getWorkUnits(projectId).then(onChange),
    );
  }

  subscribeSessions(
    projectId: string,
    onChange: (docs: SessionDoc[]) => void,
  ): Unsubscribe {
    return this.poll(
      SESSIONS,
      this.pb.filter('projectKey={:k} && inProject=true', { k: projectId }),
      () => this.getSessions(projectId).then(onChange),
    );
  }

  /** Re-fetch the (small) full list on any matching change. Realtime via SSE
   * needs an EventSource; in browsers it is native, but this source() is for
   * server-side callers (e.g. `ks-flow status`) where it may be absent, so we
   * subscribe best-effort and always do an initial load. */
  private poll(col: string, filter: string, reload: () => Promise<void>): Unsubscribe {
    void reload();
    let unsub: (() => void) | undefined;
    this.pb
      .collection(col)
      .subscribe('*', () => void reload(), { filter })
      .then((u) => {
        unsub = u;
      })
      .catch(() => {
        // no EventSource available — initial load already happened
      });
    return () => unsub?.();
  }
}

export function createPocketbaseProvider(cfg: Config): DbProvider {
  let writer: PocketbaseWriter | undefined;
  let source: PocketbaseSource | undefined;
  return {
    name: 'pocketbase',
    writer: () => (writer ??= new PocketbaseWriter(cfg)),
    source: () => (source ??= new PocketbaseSource(cfg)),
  };
}
