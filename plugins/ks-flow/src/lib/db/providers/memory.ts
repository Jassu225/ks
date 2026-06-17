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
  DbProvider,
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

export function createMemoryProvider(): DbProvider {
  const writer = new MemoryWriter();
  return { name: 'memory', writer: () => writer, source: () => noopSource };
}
