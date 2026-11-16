// lib/devicesdb.ts — SERVER-side Settings → Devices writes (app/api/devices).
//
// The board writes only three things about devices, all store-only, all merges:
//   devices/{id}.name           your name for a device (null = its default name)
//   devices/{id}.forgotten      Forget a stale device (the doc is kept; its cards
//                               become removed cards), or take it back
//   meta/settings.masterDeviceId  the device that runs the master
// Every other field of devices/{id} is its own daemon's (merge writes, so a
// name write never touches them). Nothing here writes before the device
// backfill (no meta/settings): a merge would create meta/settings and the
// backfill, which claims the store with create(), would then refuse to run.
//
// Firestore: firebase-admin through the outbox (serverdb fsWrite / fsRead:
// offline writes wait there, offline reads come from the live stream's last
// snapshot). PocketBase: `devices` / `meta` rows keyed by `key` with the doc in
// `data` (pb_migrations/1700000007_devices.js), read-modify-write of `data`.
import type PocketBase from 'pocketbase';
import { outboxEntries, overlay } from './outbox';
import { adminFirestore, fsRead, fsWrite, pbClient, plainData, serverConfig, SETTINGS_PATH, type ServerConfig } from './serverdb';
import { readScopeCache } from './storeCache';
import { deviceId as selfDeviceId } from './device';
import type { DeviceDoc, SettingsDoc } from './types';

const DEVICES = 'devices';
const META = 'meta';
/** As components/DeviceChip.tsx: a device not seen this long is asleep or offline. */
const STALE_MS = 5 * 60_000;
const NAME_MAX = 40;

export type DevicesChange =
  | { action: 'rename'; deviceId: string; name: string | null }
  | { action: 'forget'; deviceId: string; forgotten: boolean }
  | { action: 'master'; deviceId: string };

export class DevicesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ── reads ─────────────────────────────────────────────────────────────────────

async function pbRow(pb: PocketBase, col: string, key: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
  try {
    const r = await pb.collection(col).getFirstListItem(pb.filter('key={:k}', { k: key }));
    return { id: r.id, data: (r.data ?? {}) as Record<string, unknown> };
  } catch (e) {
    if ((e as { status?: number })?.status === 404) return null;
    throw e;
  }
}

export interface DevicesState {
  devices: DeviceDoc[];
  settings: SettingsDoc | null;
  self: string;
}

export async function readDevices(cfg: ServerConfig = serverConfig()): Promise<DevicesState> {
  const self = selfDeviceId(cfg.dataDir);
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    const recs = await pb.collection(DEVICES).getFullList();
    const devices = recs.map((r) => ({ ...(r.data as DeviceDoc), deviceId: String(r.key) }));
    const settings = ((await pbRow(pb, META, 'settings'))?.data as SettingsDoc | undefined) ?? null;
    return { devices, settings, self };
  }
  const fs = await adminFirestore(cfg);
  return fsRead<DevicesState>(
    async () => {
      const [devs, meta] = await Promise.all([fs.collection(DEVICES).get(), fs.doc(SETTINGS_PATH).get()]);
      return {
        devices: devs.docs.map((d) => ({ ...(d.data() as DeviceDoc), deviceId: d.id })),
        settings: meta.exists ? (meta.data() as SettingsDoc) : null,
        self,
      };
    },
    () => {
      // Offline: the live stream's last snapshot plus the writes still queued.
      const snaps = readScopeCache(cfg.dataDir, 'board')?.snaps ?? {};
      const queued = outboxEntries(cfg.dataDir);
      const devices = overlay((snaps.devices ?? []) as DeviceDoc[], queued, DEVICES, (d) => d.deviceId);
      let settings = ((snaps.settings ?? [])[0] as SettingsDoc | undefined) ?? null;
      for (const q of queued) {
        if (q.path === SETTINGS_PATH && q.op !== 'delete' && settings) settings = { ...settings, ...(q.data ?? {}) } as SettingsDoc;
      }
      return { devices, settings, self };
    },
  );
}

// ── writes ────────────────────────────────────────────────────────────────────

/** A merge into one doc: `devices/<id>` or `meta/settings`. */
interface Merge {
  path: string;
  data: Record<string, unknown>;
}

async function applyMerges(cfg: ServerConfig, merges: Merge[]): Promise<void> {
  if (merges.length === 0) return;
  if (cfg.dbProvider === 'pocketbase') {
    const pb = pbClient(cfg);
    for (const m of merges) {
      const [col, key] = m.path.split('/') as [string, string];
      const cur = await pbRow(pb, col, key);
      // Rows exist (validated before): update `data` only.
      if (cur) await pb.collection(col).update(cur.id, { data: { ...cur.data, ...plainData(m.data) } });
    }
    return;
  }
  // One batch through the outbox (all or none).
  await fsWrite(
    cfg,
    merges.map((m) => ({ op: 'merge' as const, path: m.path, data: plainData(m.data) })),
  );
}
/** Check every change against the current devices, then write them all (or none). */
export async function applyDevicesChanges(changes: DevicesChange[], now: number = Date.now()): Promise<DevicesState> {
  const cfg = serverConfig();
  const state = await readDevices(cfg);
  if (!state.settings) {
    throw new DevicesError('This store is not set up for devices yet: run the device backfill first.', 409);
  }
  const byId = new Map(state.devices.map((d) => [d.deviceId, d]));
  const merges: Merge[] = [];
  let master = state.settings.masterDeviceId;

  for (const c of changes) {
    const d = byId.get(c.deviceId);
    if (!d) throw new DevicesError(`No device ${c.deviceId}.`, 404);
    const label = d.name || d.defaultName || c.deviceId;
    if (c.action === 'rename') {
      const name = (c.name ?? '').trim().slice(0, NAME_MAX);
      merges.push({ path: `${DEVICES}/${c.deviceId}`, data: { name: name || null } });
    } else if (c.action === 'forget') {
      if (c.forgotten) {
        if (c.deviceId === state.self) throw new DevicesError('This device cannot forget itself.', 400);
        const seen = Date.parse(d.lastSeenAt ?? '');
        if (Number.isFinite(seen) && now - seen <= STALE_MS) {
          throw new DevicesError(`${label} was seen in the last 5 minutes: only a stale device can be forgotten.`, 409);
        }
        if (c.deviceId === master) {
          throw new DevicesError(`${label} is the master device: pick another master first.`, 409);
        }
      }
      merges.push({ path: `${DEVICES}/${c.deviceId}`, data: { forgotten: c.forgotten } });
    } else if (c.action === 'master') {
      if (d.forgotten) throw new DevicesError(`${label} is forgotten: take it back before making it the master.`, 409);
      if (c.deviceId !== master) {
        master = c.deviceId;
        merges.push({ path: SETTINGS_PATH, data: { masterDeviceId: c.deviceId } });
      }
    }
  }
  await applyMerges(cfg, merges);
  return readDevices(cfg).catch(() => state);
}

/** Validate the request body's `changes` list. */
export function parseChanges(body: unknown): DevicesChange[] {
  const list = (body as { changes?: unknown })?.changes;
  if (!Array.isArray(list) || list.length === 0) throw new DevicesError('changes: a non-empty list is required', 400);
  return list.map((raw): DevicesChange => {
    const c = raw as Record<string, unknown>;
    const id = typeof c?.deviceId === 'string' ? c.deviceId.trim() : '';
    if (!id || id.includes('/')) throw new DevicesError('deviceId is required', 400);
    if (c.action === 'rename') {
      if (c.name !== null && typeof c.name !== 'string') throw new DevicesError('rename: name must be a string or null', 400);
      return { action: 'rename', deviceId: id, name: c.name as string | null };
    }
    if (c.action === 'forget') {
      if (typeof c.forgotten !== 'boolean') throw new DevicesError('forget: forgotten must be true or false', 400);
      return { action: 'forget', deviceId: id, forgotten: c.forgotten };
    }
    if (c.action === 'master') return { action: 'master', deviceId: id };
    throw new DevicesError(`unknown action ${String(c?.action)}`, 400);
  });
}
