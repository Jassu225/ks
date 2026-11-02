// lib/db/providers/memory.ts — in-memory writer for dry-run / debugging.
//
// Selected when KS_FLOW_DRYRUN=1 (overrides db_provider). Captures everything
// the daemon would write, with no cloud transport, and dumps a JSON summary on
// shutdown — so the full backfill → derive → join → materialize pipeline can be
// exercised end-to-end without a Firestore. The source() is a no-op (the board
// is never pointed at this provider).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DATA_DIR } from '../../paths.js';
import { join as pjoin } from 'node:path';
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
  WorkUnitDoc,
} from '../types.js';

class MemoryWriter implements SessionWriter {
  sessions = new Map<string, SessionDoc>();
  workUnits = new Map<string, WorkUnitDoc>();
  project: ProjectDoc | null = null;
  writes = 0;

  async upsertSession(_p: string, doc: SessionDoc): Promise<void> {
    this.sessions.set(doc.sessionId, doc);
    this.writes++;
  }
  async upsertMany(_p: string, docs: SessionDoc[]): Promise<void> {
    for (const d of docs) this.sessions.set(d.sessionId, d);
    this.writes++;
  }
  async upsertWorkUnit(_p: string, doc: WorkUnitDoc): Promise<void> {
    this.workUnits.set(doc.unitId, doc);
    this.writes++;
  }
  async upsertProject(doc: ProjectDoc): Promise<void> {
    this.project = doc;
    this.writes++;
  }
  async markArchived(_p: string, id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.archived = true;
  }
  reminders = new Map<string, ReminderDoc>();
  async getReminders(): Promise<ReminderDoc[]> {
    return [...this.reminders.values()];
  }
  async upsertReminder(_p: string, doc: ReminderDoc): Promise<void> {
    this.reminders.set(doc.uid, doc);
  }
  async deleteReminder(_p: string, uid: string): Promise<void> {
    this.reminders.delete(uid);
  }
  async close(): Promise<void> {
    const dump = {
      writes: this.writes,
      project: this.project,
      sessionCount: this.sessions.size,
      workUnitCount: this.workUnits.size,
      waitingUnits: [...this.workUnits.values()].filter((u) => u.waiting?.active).length,
      sessions: [...this.sessions.values()],
      workUnits: [...this.workUnits.values()],
    };
    const out = pjoin(DATA_DIR, 'dryrun-dump.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(dump, null, 2));
    console.log(
      `[ks-flow] DRYRUN dump → ${out}  (sessions=${this.sessions.size} workUnits=${this.workUnits.size} phaseModel=${this.project?.phaseModel.length ?? 0} cols)`,
    );
  }
}

const noopSource: SessionSource = {
  async getProject() {
    return null;
  },
  async getWorkUnits() {
    return [];
  },
  async getSessions() {
    return [];
  },
  async getReminders() {
    return [];
  },
  subscribeWorkUnits() {
    return () => {};
  },
  subscribeSessions() {
    return () => {};
  },
  subscribeReminders() {
    return () => {};
  },
};

/** Backups held for the life of the process (a dry run's sweep reads its own writes). */
class MemoryBackups implements BackupStore {
  units = new Map<string, BackupUnitDoc>();
  runs = new Map<string, BackupRunDoc>();
  async getBackupUnits(): Promise<BackupUnitDoc[]> {
    return [...this.units.values()];
  }
  async upsertBackupUnit(_p: string, doc: BackupUnitDoc): Promise<void> {
    this.units.set(doc.uid, doc);
  }
  async getBackupRuns(): Promise<BackupRunDoc[]> {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async upsertBackupRun(_p: string, doc: BackupRunDoc): Promise<void> {
    this.runs.set(doc.uid, doc);
  }
}

/** Briefing held for the life of the process (also what the CLI tests run against).
 * Docs are copied in and out, as a real store would. */
export class MemoryBriefing implements BriefingStore {
  items = new Map<string, BriefingItemDoc>();
  runs = new Map<string, BriefingRunDoc>();
  daily = new Map<string, DailyLogDoc>();
  async getBriefingItems(_p: string, filter: BriefingItemFilter = {}): Promise<BriefingItemDoc[]> {
    return [...this.items.values()]
      .filter((d) => (!filter.status || d.status === filter.status) && (!filter.groupKey || d.groupKey === filter.groupKey))
      .map((d) => structuredClone(d));
  }
  async getBriefingItem(_p: string, uid: string): Promise<BriefingItemDoc | null> {
    const d = this.items.get(uid);
    return d ? structuredClone(d) : null;
  }
  async upsertBriefingItem(_p: string, doc: BriefingItemDoc): Promise<void> {
    this.items.set(doc.uid, structuredClone(doc));
  }
  async getBriefingRuns(): Promise<BriefingRunDoc[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((d) => structuredClone(d));
  }
  async getBriefingRun(_p: string, uid: string): Promise<BriefingRunDoc | null> {
    const d = this.runs.get(uid);
    return d ? structuredClone(d) : null;
  }
  async upsertBriefingRun(_p: string, doc: BriefingRunDoc): Promise<void> {
    this.runs.set(doc.uid, structuredClone(doc));
  }
  async getDailyLog(_p: string, date: string): Promise<DailyLogDoc | null> {
    const d = this.daily.get(date);
    return d ? structuredClone(d) : null;
  }
  async getDailyLogs(): Promise<DailyLogDoc[]> {
    return [...this.daily.values()].sort((a, b) => b.date.localeCompare(a.date)).map((d) => structuredClone(d));
  }
  async upsertDailyLog(_p: string, doc: DailyLogDoc): Promise<void> {
    this.daily.set(doc.uid, structuredClone(doc));
  }
  masterEvents = new Map<string, MasterEventDoc>();
  async getMasterEvents(_p: string, limit = 200): Promise<MasterEventDoc[]> {
    return [...this.masterEvents.values()]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }
  async upsertMasterEvent(_p: string, doc: MasterEventDoc): Promise<void> {
    this.masterEvents.set(doc.uid, structuredClone(doc));
  }
}

export function createMemoryProvider(): DbProvider {
  const writer = new MemoryWriter();
  const backups = new MemoryBackups();
  const briefing = new MemoryBriefing();
  return {
    name: 'memory',
    writer: () => writer,
    source: () => noopSource,
    backups: () => backups,
    briefing: () => briefing,
  };
}
