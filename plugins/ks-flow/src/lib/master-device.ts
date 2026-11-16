// lib/master-device.ts — one master, on the device chosen in Settings → Devices
// (meta/settings.masterDeviceId).
//
// Only that device's daemon runs the Briefing schedule and the master
// supervisor, and publishes the master's status to devices/{self}.master. The
// boards of other devices ask it for a start, a run or a restart through
// `masterRequests/{uid}` docs ({trigger, from, createdAt}); its daemon takes
// each one (listener, with the 15 s tick as fallback), turns it into the local
// file the board on the master device would have written (start-request.json
// or requests/<iso>-<trigger>.json), deletes the doc and records the
// masterEvents entry. A request older than 15 min is dropped unread.
//
// Before the device backfill (no meta/settings), every device is its own
// master, as before.
import type { DeviceStore, MasterRequestDoc, SettingsDoc } from './db/types.js';
import { REMOTE_REQUEST_TTL_MS } from './master.js';

/** Whether this device runs the master: the chosen one, or any device before the backfill. */
export function isMasterDevice(settings: Pick<SettingsDoc, 'masterDeviceId'> | null | undefined, self: string, deviceMode: boolean): boolean {
  if (!deviceMode || !settings || !settings.masterDeviceId) return true;
  return settings.masterDeviceId === self;
}

/** Whether a request is too old to act on (an unreadable time counts as too old). */
export function requestExpired(req: Pick<MasterRequestDoc, 'createdAt'>, now: number): boolean {
  const at = Date.parse(req.createdAt);
  return !Number.isFinite(at) || now - at > REMOTE_REQUEST_TTL_MS;
}

/**
 * Takes masterRequests one pass at a time (a listener and the tick may both
 * deliver the same docs): each is handled once, then deleted. A handler that
 * throws is logged and its doc deleted all the same, so a bad request can't
 * come back every 15 s.
 */
export class MasterRequestQueue {
  private seen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Pick<DeviceStore, 'getMasterRequests' | 'deleteMasterRequest'>,
    private handle: (req: MasterRequestDoc, expired: boolean) => Promise<void> | void,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Handle the given requests (a listener's list), or read them now. Resolves when this pass is done. */
  take(list?: MasterRequestDoc[], now: () => number = Date.now): Promise<{ handled: string[]; expired: string[] }> {
    const run = this.chain.then(() => this.pass(list, now));
    this.chain = run.catch(() => {});
    return run;
  }

  private async pass(list: MasterRequestDoc[] | undefined, now: () => number): Promise<{ handled: string[]; expired: string[] }> {
    const out = { handled: [] as string[], expired: [] as string[] };
    let reqs: MasterRequestDoc[];
    try {
      reqs = list ?? (await this.store.getMasterRequests());
    } catch (e) {
      this.log(`master requests: not readable (${(e as Error)?.message}); next tick retries`);
      return out;
    }
    // Forget uids no longer waiting (their delete went through).
    const waiting = new Set(reqs.map((r) => r.uid));
    for (const uid of this.seen) if (!waiting.has(uid)) this.seen.delete(uid);
    for (const req of [...reqs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (!req.uid) continue;
      if (this.seen.has(req.uid)) {
        // Handled already, its delete not through yet: the tick's pass tries the delete again.
        if (!list) await this.store.deleteMasterRequest(req.uid).catch(() => {});
        continue;
      }
      this.seen.add(req.uid);
      const expired = requestExpired(req, now());
      try {
        await this.handle(req, expired);
      } catch (e) {
        this.log(`master requests: ${req.trigger} from ${req.from} failed (${(e as Error)?.message})`);
      }
      (expired ? out.expired : out.handled).push(req.uid);
      try {
        await this.store.deleteMasterRequest(req.uid);
      } catch (e) {
        this.log(`master requests: ${req.uid} not deleted (${(e as Error)?.message})`);
      }
    }
    return out;
  }
}
