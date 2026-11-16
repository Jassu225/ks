// lib/device-retag.ts — move everything one device id owns to another and
// drop the old devices/{id} record. For a device that ran under a wrong id
// (a daemon that fell back to the host-name id), never for two real devices:
// the run refuses while the old id still sends heartbeats. Run by the
// standalone scripts/one-off/retag-device.ts.
import { OWNED_COLLECTIONS, type DocDb, type OwnedCollection } from './db/types.js';
import type { StoreOp } from './db/outbox.js';
import { MAX_CHUNK } from './device-backfill.js';

export interface RetagOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  /** A heartbeat newer than this blocks the run (default 3 min: the old daemon still runs). */
  staleAfterMs?: number;
  now?: () => Date;
  log?: (m: string) => void;
}

export interface RetagResult {
  refused?: string;
  retagged: Record<OwnedCollection, number>;
  /** devices/{from}: deleted (or would be), or missing. */
  device: 'deleted' | 'missing';
  /** meta/settings.masterDeviceId was the old id and is (or would be) moved. */
  master: boolean;
  batches: number;
}

const DEFAULT_STALE_MS = 3 * 60_000;

export async function retagDevice(db: DocDb, opts: RetagOptions): Promise<RetagResult> {
  const { from, to } = opts;
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date()))();
  const retagged = Object.fromEntries(OWNED_COLLECTIONS.map((c) => [c, 0])) as Record<OwnedCollection, number>;
  const res: RetagResult = { retagged, device: 'missing', master: false, batches: 0 };

  if (!from || !to) return { ...res, refused: 'both --from and the target id are needed' };
  if (from === to) return { ...res, refused: `${from} is this device's id: nothing to move` };
  const old = await db.get(`devices/${from}`);
  const target = await db.get(`devices/${to}`);
  if (!target) return { ...res, refused: `devices/${to} does not exist: start this device's daemon first` };
  const seen = typeof old?.lastSeenAt === 'string' ? Date.parse(old.lastSeenAt) : NaN;
  if (!Number.isNaN(seen) && now.getTime() - seen < (opts.staleAfterMs ?? DEFAULT_STALE_MS)) {
    return {
      ...res,
      refused: `devices/${from} sent a heartbeat ${Math.round((now.getTime() - seen) / 1000)}s ago: a daemon still runs under that id (stop it first, wait 3 min)`,
    };
  }
  res.device = old ? 'deleted' : 'missing';

  const settings = await db.get('meta/settings');
  res.master = settings?.masterDeviceId === from;

  for (const coll of OWNED_COLLECTIONS) {
    const ids = (await db.list(coll, ['deviceId'])).filter((d) => d.data.deviceId === from).map((d) => d.id);
    retagged[coll] = ids.length;
    if (opts.dryRun) continue;
    for (let i = 0; i < ids.length; i += MAX_CHUNK) {
      const ops: StoreOp[] = ids.slice(i, i + MAX_CHUNK).map((id) => ({ op: 'merge', path: `${coll}/${id}`, data: { deviceId: to } }));
      await db.write(ops);
      res.batches++;
    }
    if (ids.length) log(`${coll}: moved ${ids.length} doc(s) to ${to}`);
  }
  if (opts.dryRun) return res;
  if (res.master) {
    await db.write([{ op: 'merge', path: 'meta/settings', data: { masterDeviceId: to } }]);
    log(`meta/settings: master device ${from} → ${to}`);
  }
  if (old) {
    await db.write([{ op: 'delete', path: `devices/${from}` }]);
    log(`devices/${from} deleted`);
  }
  return res;
}
