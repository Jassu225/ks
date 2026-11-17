// lib/live-sources.ts — the listeners the daemon keeps (lib/live-mirror.ts),
// built over the store's path-level DocDb (Firestore). Each one replaces a read
// a job used to make on a timer:
//   settings       meta/settings                    device mode, master device, shared settings, releases
//   devices        devices                          labels, the devices cache (peers), names in logs
//   foreignCards   workUnits where deviceId != self card ownership (a card-move by another device)
//   reminders      reminders                        the reminder engine (every 30 s)
//   openItems      briefingItems where status=open  Briefing notices (every 60 s)
//   backupRuns     the newest 100 backupRuns         the daily sweep check, backup status, Activity
//   backupUnits    backupUnits                      backup status (what the bucket holds per unit)
//   masterRequests masterRequests                   the master device only
import type { DeviceStore, DocDb, WatchQuery, BackupRunDoc, BackupUnitDoc, BriefingItemDoc, DeviceDoc, MasterRequestDoc, ReminderDoc, SettingsDoc } from './db/types.js';
import type { LiveSpec } from './live-mirror.js';

/** The newest backup runs the listener keeps: today's sweep check needs a few, Activity's history the rest. */
export const BACKUP_RUNS_KEPT = 100;

function withUid<T>(docs: Array<{ id: string; data: Record<string, unknown> }>): T[] {
  return docs.map((d) => ({ ...d.data, uid: typeof d.data.uid === 'string' && d.data.uid ? d.data.uid : d.id }) as T);
}

function collection<T>(db: DocDb, name: string, label: string, coll: string, query?: WatchQuery): LiveSpec<T[]> {
  return {
    name,
    label,
    attach: (onData, onError) => db.watch!(coll, [], (docs) => onData(withUid<T>(docs)), onError, query),
  };
}

export interface LiveSources {
  settings: LiveSpec<SettingsDoc | null>;
  devices: LiveSpec<DeviceDoc[]>;
  foreignCards: LiveSpec<Array<{ unitId: string; deviceId: string }>>;
  reminders: LiveSpec<ReminderDoc[]>;
  openItems: LiveSpec<BriefingItemDoc[]>;
  backupRuns: LiveSpec<BackupRunDoc[]>;
  backupUnits: LiveSpec<BackupUnitDoc[]>;
  masterRequests: LiveSpec<MasterRequestDoc[]>;
}

/** The listener specs, or null where the store can't listen (PocketBase: a local server, read directly as before). */
export function liveSources(db: DocDb | undefined, store: DeviceStore, self: string): LiveSources | null {
  if (!db?.watch || !db.watchDoc || !store.watchSettings || !store.watchDevices || !store.watchForeignCards || !store.watchMasterRequests) return null;
  return {
    settings: { name: 'settings', label: 'Shared settings (meta/settings)', attach: (d, e) => store.watchSettings!(d, e) },
    devices: { name: 'devices', label: 'Devices', attach: (d, e) => store.watchDevices!(d, e) },
    foreignCards: { name: 'foreignCards', label: "Other devices' cards", attach: (d, e) => store.watchForeignCards!(self, d, e) },
    reminders: collection<ReminderDoc>(db, 'reminders', 'Reminders', 'reminders'),
    openItems: collection<BriefingItemDoc>(db, 'openItems', 'Open Briefing items', 'briefingItems', { where: [{ field: 'status', op: '==', value: 'open' }] }),
    backupRuns: collection<BackupRunDoc>(db, 'backupRuns', 'Backup runs', 'backupRuns', { orderBy: 'startedAt', desc: true, limit: BACKUP_RUNS_KEPT }),
    backupUnits: collection<BackupUnitDoc>(db, 'backupUnits', 'Backup index', 'backupUnits'),
    masterRequests: { name: 'masterRequests', label: 'Master requests', attach: (d, e) => store.watchMasterRequests!(d, e) },
  };
}
