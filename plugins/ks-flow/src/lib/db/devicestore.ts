// lib/db/devicestore.ts — the DeviceStore over any DocDb: Firestore
// (providers/firestore.ts) and the in-memory fake (docdb.ts) share this code.
//
// Paths (flat, at the database root, like every ks-flow collection):
//   devices/{deviceId}       ← one per device; merge writes only
//   meta/settings            ← the shared settings + masterDeviceId
//   masterRequests/{uid}     ← asks for the master device's daemon
//   workUnits/{unitId}       ← the cards (owner = `deviceId`)
//   meta/project             ← retired; read and deleted by the backfill
import type {
  DeviceDoc,
  DeviceStore,
  DocDb,
  MasterRequestDoc,
  ProjectDoc,
  SettingsDoc,
  Unsubscribe,
  WorkUnitDoc,
} from './types.js';

export const DEVICES = 'devices';
export const SETTINGS_PATH = 'meta/settings';
export const LEGACY_PROJECT_PATH = 'meta/project';
export const MASTER_REQUESTS = 'masterRequests';
export const WORK_UNITS = 'workUnits';

/** Firestore refuses `undefined` fields; a JSON round-trip drops them. */
function plain<T extends object>(doc: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

export function docDeviceStore(db: DocDb): DeviceStore {
  return {
    async getDevices() {
      return (await db.list(DEVICES)).map((d) => ({ ...(d.data as unknown as DeviceDoc), deviceId: d.id }));
    },
    async getDevice(deviceId) {
      const d = await db.get(`${DEVICES}/${deviceId}`);
      return d ? ({ ...(d as unknown as DeviceDoc), deviceId }) : null;
    },
    async mergeDevice(deviceId, patch) {
      await db.write([{ op: 'merge', path: `${DEVICES}/${deviceId}`, data: plain({ ...patch, deviceId }) }]);
    },
    async getSettings() {
      return (await db.get(SETTINGS_PATH)) as SettingsDoc | null;
    },
    async mergeSettings(patch) {
      await db.write([{ op: 'merge', path: SETTINGS_PATH, data: plain(patch) }]);
    },
    async createSettings(doc) {
      return db.create(SETTINGS_PATH, plain(doc));
    },
    async getMasterRequests() {
      return (await db.list(MASTER_REQUESTS))
        .map((d) => ({ ...(d.data as unknown as MasterRequestDoc), uid: d.id }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async addMasterRequest(doc) {
      await db.write([{ op: 'set', path: `${MASTER_REQUESTS}/${doc.uid}`, data: plain(doc) }]);
    },
    async deleteMasterRequest(uid) {
      await db.write([{ op: 'delete', path: `${MASTER_REQUESTS}/${uid}` }]);
    },
    async getWorkUnit(unitId) {
      return (await db.get(`${WORK_UNITS}/${unitId}`)) as WorkUnitDoc | null;
    },
    async setWorkUnitOwner(unitId, deviceId) {
      await db.write([{ op: 'merge', path: `${WORK_UNITS}/${unitId}`, data: { deviceId } }]);
    },
    async getLegacyProject() {
      return (await db.get(LEGACY_PROJECT_PATH)) as ProjectDoc | null;
    },
    async deleteLegacyProject() {
      await db.write([{ op: 'delete', path: LEGACY_PROJECT_PATH }]);
    },
    ...(db.transact
      ? {
          async raiseVersion(patch: (current: SettingsDoc | null) => Partial<SettingsDoc> | null) {
            const out = await db.transact!(SETTINGS_PATH, (cur) => {
              const p = patch(cur as SettingsDoc | null);
              return p ? plain(p) : null;
            });
            return out as SettingsDoc | null;
          },
        }
      : {}),
    ...(db.watchDoc
      ? {
          watchSettings(onChange: (settings: SettingsDoc | null) => void): Unsubscribe {
            return db.watchDoc!(SETTINGS_PATH, (d) => onChange(d as SettingsDoc | null));
          },
        }
      : {}),
    ...(db.watch
      ? {
          watchMasterRequests(onChange: (requests: MasterRequestDoc[]) => void): Unsubscribe {
            return db.watch!(MASTER_REQUESTS, [], (docs) =>
              onChange(
                docs
                  .map((d) => ({ ...(d.data as unknown as MasterRequestDoc), uid: d.id }))
                  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
              ),
            );
          },
          watchCardOwners(onChange: (owners: Array<{ unitId: string; deviceId: string | null }>) => void): Unsubscribe {
            return db.watch!(WORK_UNITS, ['deviceId'], (docs) =>
              onChange(
                docs.map((d) => ({
                  unitId: d.id,
                  deviceId: typeof d.data.deviceId === 'string' && d.data.deviceId ? d.data.deviceId : null,
                })),
              ),
            );
          },
        }
      : {}),
  };
}
