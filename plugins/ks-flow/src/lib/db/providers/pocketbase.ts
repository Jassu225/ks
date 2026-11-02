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
  BackupRunDoc,
  BackupStore,
  BackupUnitDoc,
  BriefingItemDoc,
  BriefingItemFilter,
  BriefingRunDoc,
  BriefingStore,
  DailyLogDoc,
  DbProvider,
  MasterEventDoc,
  ProjectDoc,
  ReminderDoc,
  SessionDoc,
  SessionSource,
  SessionWriter,
  Unsubscribe,
  WorkUnitDoc,
} from '../types.js';

const PROJECTS = 'projects';
const WORK_UNITS = 'work_units';
const SESSIONS = 'sessions';
const REMINDERS = 'reminders';
const BACKUP_UNITS = 'backup_units';
const BACKUP_RUNS = 'backup_runs';
const BRIEFING_ITEMS = 'briefing_items';
const BRIEFING_RUNS = 'briefing_runs';
const DAILY_LOGS = 'daily_logs';
const MASTER_EVENTS = 'master_events';

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

  // ── reminders ─────────────────────────────────────────────────────────────
  // The reminders collection is keyed by `uid` (not `key`), so it can't use the
  // shared `key`-based upsert helper above.
  async getReminders(projectId: string): Promise<ReminderDoc[]> {
    const recs = await this.pb
      .collection(REMINDERS)
      .getFullList({ filter: this.pb.filter('projectKey={:k}', { k: projectId }) });
    return recs.map((r) => r.data as ReminderDoc);
  }

  async upsertReminder(projectId: string, doc: ReminderDoc): Promise<void> {
    const cacheKey = `${REMINDERS}:${doc.uid}`;
    const body = {
      uid: doc.uid,
      projectKey: projectId,
      unitKey: doc.unitId ?? '',
      data: doc,
    };
    let id = this.ids.get(cacheKey);
    if (!id) {
      try {
        const rec = await this.pb
          .collection(REMINDERS)
          .getFirstListItem(this.pb.filter('uid={:u}', { u: doc.uid }));
        id = rec.id;
        this.ids.set(cacheKey, id);
      } catch {
        // 404 → create below
      }
    }
    if (id) {
      try {
        await this.pb.collection(REMINDERS).update(id, body);
        return;
      } catch (e) {
        if (statusOf(e) === 404) this.ids.delete(cacheKey);
        else throw e;
      }
    }
    const rec = await this.pb.collection(REMINDERS).create(body);
    this.ids.set(cacheKey, rec.id);
  }

  async deleteReminder(_projectId: string, uid: string): Promise<void> {
    const cacheKey = `${REMINDERS}:${uid}`;
    try {
      let id = this.ids.get(cacheKey);
      if (!id) {
        const rec = await this.pb
          .collection(REMINDERS)
          .getFirstListItem(this.pb.filter('uid={:u}', { u: uid }));
        id = rec.id;
      }
      await this.pb.collection(REMINDERS).delete(id);
      this.ids.delete(cacheKey);
    } catch {
      // already gone
    }
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

  async getReminders(projectId: string): Promise<ReminderDoc[]> {
    const recs = await this.pb
      .collection(REMINDERS)
      .getFullList({ filter: this.pb.filter('projectKey={:k}', { k: projectId }) });
    return recs.map((r) => r.data as ReminderDoc);
  }

  subscribeWorkUnits(
    projectId: string,
    onChange: (docs: WorkUnitDoc[]) => void,
  ): Unsubscribe {
    return this.poll(WORK_UNITS, this.pb.filter('projectKey={:k}', { k: projectId }), () =>
      this.getWorkUnits(projectId).then(onChange),
    );
  }

  subscribeReminders(
    projectId: string,
    onChange: (docs: ReminderDoc[]) => void,
  ): Unsubscribe {
    return this.poll(REMINDERS, this.pb.filter('projectKey={:k}', { k: projectId }), () =>
      this.getReminders(projectId).then(onChange),
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

/** The backup CLI's store: backup_units (the bucket cache) and backup_runs (sweep history). */
class PocketbaseBackups implements BackupStore {
  private pb: PocketBase;
  private ids = new Map<string, string>();
  constructor(cfg: Config) {
    this.pb = client(cfg);
  }

  /** Insert-or-update the record `filter` finds (keyed by `uid`, like reminders). */
  private async upsert(col: string, filter: string, body: Record<string, unknown>): Promise<void> {
    const cacheKey = `${col}:${filter}`;
    let id = this.ids.get(cacheKey);
    if (!id) {
      try {
        id = (await this.pb.collection(col).getFirstListItem(filter)).id;
        this.ids.set(cacheKey, id);
      } catch (e) {
        if (statusOf(e) !== 404) throw e; // unreachable is an error, not "absent"
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
    const rec = await this.pb.collection(col).create(body);
    this.ids.set(cacheKey, rec.id);
  }

  async getBackupUnits(projectId: string): Promise<BackupUnitDoc[]> {
    const recs = await this.pb
      .collection(BACKUP_UNITS)
      .getFullList({ filter: this.pb.filter('projectKey={:k}', { k: projectId }) });
    return recs.map((r) => r.data as BackupUnitDoc);
  }

  async upsertBackupUnit(projectId: string, doc: BackupUnitDoc): Promise<void> {
    await this.upsert(BACKUP_UNITS, this.pb.filter('projectKey={:k} && uid={:u}', { k: projectId, u: doc.uid }), {
      uid: doc.uid,
      projectKey: projectId,
      data: doc,
    });
  }

  async getBackupRuns(projectId: string): Promise<BackupRunDoc[]> {
    const recs = await this.pb.collection(BACKUP_RUNS).getFullList({
      filter: this.pb.filter('projectKey={:k}', { k: projectId }),
      sort: '-startedAt',
    });
    return recs.map((r) => r.data as BackupRunDoc);
  }

  async upsertBackupRun(projectId: string, doc: BackupRunDoc): Promise<void> {
    await this.upsert(BACKUP_RUNS, this.pb.filter('uid={:u}', { u: doc.uid }), {
      uid: doc.uid,
      projectKey: projectId,
      startedAt: doc.startedAt,
      data: doc,
    });
  }
}

/** The briefing store: briefing_items, briefing_runs, daily_logs and
 * master_events. Keyed by `uid` within a project; `key`/`groupKey`/`status`/
 * `dueAt`/`archivedAt` (items), `startedAt` (runs), `date` (daily logs) and
 * `at` (master events) are mirrored out of `data` so the
 * board and the CLI filter and sort server-side. */
class PocketbaseBriefing implements BriefingStore {
  private pb: PocketBase;
  private ids = new Map<string, string>();
  constructor(cfg: Config) {
    this.pb = client(cfg);
  }

  /** Insert-or-update the record `filter` finds (same as the backups store). */
  private async upsert(col: string, filter: string, body: Record<string, unknown>): Promise<void> {
    const cacheKey = `${col}:${filter}`;
    let id = this.ids.get(cacheKey);
    if (!id) {
      try {
        id = (await this.pb.collection(col).getFirstListItem(filter)).id;
        this.ids.set(cacheKey, id);
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
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
    const rec = await this.pb.collection(col).create(body);
    this.ids.set(cacheKey, rec.id);
  }

  /** The one record `filter` finds, or null when there is none. */
  private async first<T>(col: string, filter: string): Promise<T | null> {
    try {
      return (await this.pb.collection(col).getFirstListItem(filter)).data as T;
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  private byUid(projectId: string, uid: string): string {
    return this.pb.filter('projectKey={:k} && uid={:u}', { k: projectId, u: uid });
  }

  async getBriefingItems(projectId: string, filter: BriefingItemFilter = {}): Promise<BriefingItemDoc[]> {
    // Only pass params that are set: pb.filter() JSON-stringifies each value
    // and throws on `undefined` (JSON.stringify(undefined).replace …).
    const parts = ['projectKey={:k}'];
    const params: Record<string, string> = { k: projectId };
    if (filter.status) {
      parts.push('status={:s}');
      params.s = filter.status;
    }
    if (filter.groupKey) {
      parts.push('groupKey={:g}');
      params.g = filter.groupKey;
    }
    const recs = await this.pb.collection(BRIEFING_ITEMS).getFullList({
      filter: this.pb.filter(parts.join(' && '), params),
      sort: 'dueAt',
    });
    return recs.map((r) => r.data as BriefingItemDoc);
  }

  async getBriefingItem(projectId: string, uid: string): Promise<BriefingItemDoc | null> {
    return this.first<BriefingItemDoc>(BRIEFING_ITEMS, this.byUid(projectId, uid));
  }

  async upsertBriefingItem(projectId: string, doc: BriefingItemDoc): Promise<void> {
    await this.upsert(BRIEFING_ITEMS, this.byUid(projectId, doc.uid), {
      uid: doc.uid,
      projectKey: projectId,
      key: doc.key,
      groupKey: doc.groupKey,
      status: doc.status,
      dueAt: doc.dueAt,
      archivedAt: doc.archivedAt ?? '',
      data: doc,
    });
  }

  async getBriefingRuns(projectId: string): Promise<BriefingRunDoc[]> {
    const recs = await this.pb.collection(BRIEFING_RUNS).getFullList({
      filter: this.pb.filter('projectKey={:k}', { k: projectId }),
      sort: '-startedAt',
    });
    return recs.map((r) => r.data as BriefingRunDoc);
  }

  async getBriefingRun(projectId: string, uid: string): Promise<BriefingRunDoc | null> {
    return this.first<BriefingRunDoc>(BRIEFING_RUNS, this.byUid(projectId, uid));
  }

  async upsertBriefingRun(projectId: string, doc: BriefingRunDoc): Promise<void> {
    await this.upsert(BRIEFING_RUNS, this.byUid(projectId, doc.uid), {
      uid: doc.uid,
      projectKey: projectId,
      startedAt: doc.startedAt,
      data: doc,
    });
  }

  async getDailyLog(projectId: string, date: string): Promise<DailyLogDoc | null> {
    return this.first<DailyLogDoc>(DAILY_LOGS, this.byUid(projectId, date));
  }

  async getDailyLogs(projectId: string): Promise<DailyLogDoc[]> {
    const recs = await this.pb.collection(DAILY_LOGS).getFullList({
      filter: this.pb.filter('projectKey={:k}', { k: projectId }),
      sort: '-date',
    });
    return recs.map((r) => r.data as DailyLogDoc);
  }

  async upsertDailyLog(projectId: string, doc: DailyLogDoc): Promise<void> {
    await this.upsert(DAILY_LOGS, this.byUid(projectId, doc.uid), {
      uid: doc.uid,
      projectKey: projectId,
      date: doc.date,
      data: doc,
    });
  }

  async getMasterEvents(projectId: string, limit = 200): Promise<MasterEventDoc[]> {
    const res = await this.pb.collection(MASTER_EVENTS).getList(1, limit, {
      filter: this.pb.filter('projectKey={:k}', { k: projectId }),
      sort: '-at',
    });
    return res.items.map((r) => r.data as MasterEventDoc);
  }

  async upsertMasterEvent(projectId: string, doc: MasterEventDoc): Promise<void> {
    await this.upsert(MASTER_EVENTS, this.byUid(projectId, doc.uid), {
      uid: doc.uid,
      projectKey: projectId,
      at: doc.at,
      data: doc,
    });
  }
}

export function createPocketbaseProvider(cfg: Config): DbProvider {
  let writer: PocketbaseWriter | undefined;
  let source: PocketbaseSource | undefined;
  let backups: PocketbaseBackups | undefined;
  let briefing: PocketbaseBriefing | undefined;
  return {
    name: 'pocketbase',
    writer: () => (writer ??= new PocketbaseWriter(cfg)),
    source: () => (source ??= new PocketbaseSource(cfg)),
    backups: () => (backups ??= new PocketbaseBackups(cfg)),
    briefing: () => (briefing ??= new PocketbaseBriefing(cfg)),
  };
}
