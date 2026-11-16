// lib/device-backfill.ts — the one-time move of a one-device store to the
// several-devices model, run by hand on the device that has been using the
// board (scripts/one-off/backfill-devices.ts) before any other device starts
// its daemon:
//   1. claims meta/settings with a create() (refused when it exists): the
//      shared blocks of this device's board-settings.json, masterDeviceId =
//      this device, and a `backfill` marker (running → done);
//   2. tags every doc of the owned collections that has no `deviceId` with
//      this device: merge ops, at most 500 per batch, through the outbox;
//   3. copies meta/project's device facts into devices/{self} (merge), then
//      deletes meta/project.
// A run that stopped half-way (crash, network) can be re-run on the SAME
// device: its own `running` marker lets it resume; every other case refuses.
// Pure over a DocDb, so the tests run it against the in-memory fake.
import type { DeviceDoc, DocDb, OwnedCollection, SettingsDoc } from './db/types.js';
import { OWNED_COLLECTIONS } from './db/types.js';
import { DEVICES, LEGACY_PROJECT_PATH, SETTINGS_PATH } from './db/devicestore.js';
import type { StoreOp } from './db/outbox.js';

/** Firestore's batch limit. */
export const MAX_CHUNK = 500;

/** The board-settings.json blocks every device shares (the rest stays local). */
export const SHARED_BLOCKS = ['briefing', 'notes', 'reminders', 'gcsArchive', 'transcriptBackup'] as const;

/** The shared blocks out of a parsed board-settings.json. */
export function sharedBlocks(boardSettings: unknown): Partial<SettingsDoc> {
  const out: Record<string, unknown> = {};
  if (boardSettings && typeof boardSettings === 'object') {
    for (const k of SHARED_BLOCKS) {
      const v = (boardSettings as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
    }
  }
  return out as Partial<SettingsDoc>;
}

export interface BackfillOptions {
  deviceId: string;
  defaultName: string;
  platform: string;
  /** board-settings.json's shared blocks (sharedBlocks()). */
  shared: Partial<SettingsDoc>;
  dryRun?: boolean;
  /** Ops per batch (≤ MAX_CHUNK). */
  chunk?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  /** Why nothing was done, when refused. */
  refused: string | null;
  dryRun: boolean;
  resumed: boolean;
  /** Docs tagged (or, dry run, to tag) per collection. */
  tagged: Record<OwnedCollection, number>;
  /** Docs that already carried a deviceId (left alone). */
  alreadyTagged: Record<OwnedCollection, number>;
  /** Write batches sent for the tags. */
  batches: number;
  /** meta/project: copied into devices/{self} and deleted, or there was none. */
  project: 'copied' | 'none';
}

const zero = (): Record<OwnedCollection, number> =>
  Object.fromEntries(OWNED_COLLECTIONS.map((c) => [c, 0])) as Record<OwnedCollection, number>;

/** The device facts meta/project held, as a devices/{id} patch. */
export function deviceFactsFromProject(p: Record<string, unknown>): Partial<DeviceDoc> {
  const out: Partial<DeviceDoc> = {};
  if (typeof p.projectPath === 'string') out.projectPath = p.projectPath;
  if (typeof p.commonDir === 'string') out.commonDir = p.commonDir;
  if (Array.isArray(p.worktreePaths)) out.worktreePaths = p.worktreePaths.filter((x): x is string => typeof x === 'string');
  if (typeof p.inboxUrl === 'string' || p.inboxUrl === null) out.inboxUrl = p.inboxUrl as string | null;
  if (typeof p.inboxRunning === 'boolean') out.inboxRunning = p.inboxRunning;
  if (typeof p.linearCheckedAt === 'string' || p.linearCheckedAt === null) out.linearCheckedAt = p.linearCheckedAt as string | null;
  return out;
}

export async function backfillDevices(db: DocDb, opts: BackfillOptions): Promise<BackfillResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const chunk = Math.max(1, Math.min(opts.chunk ?? MAX_CHUNK, MAX_CHUNK));
  const self = opts.deviceId;
  const res: BackfillResult = {
    refused: null,
    dryRun: !!opts.dryRun,
    resumed: false,
    tagged: zero(),
    alreadyTagged: zero(),
    batches: 0,
    project: 'none',
  };

  // 1. meta/settings: absent → claim it; our own unfinished run → resume.
  const refuseFor = (s: SettingsDoc): string | null => {
    const b = s.backfill;
    if (b && b.state === 'running' && b.by === self) return null;
    if (b) return `meta/settings already exists: the backfill ran on device ${b.by} (${b.state}, started ${b.startedAt})`;
    return 'meta/settings already exists: this store is already set up for devices';
  };
  const existing = (await db.get(SETTINGS_PATH)) as SettingsDoc | null;
  if (existing) {
    res.refused = refuseFor(existing);
    if (res.refused) return res;
    res.resumed = true;
    log(`resuming the backfill this device started at ${existing.backfill!.startedAt}`);
  }

  // What there is to do (the dry run stops after counting).
  const untagged = new Map<OwnedCollection, string[]>();
  for (const coll of OWNED_COLLECTIONS) {
    const docs = await db.list(coll, ['deviceId']);
    const ids = docs.filter((d) => typeof d.data.deviceId !== 'string' || !d.data.deviceId).map((d) => d.id);
    untagged.set(coll, ids);
    res.tagged[coll] = ids.length;
    res.alreadyTagged[coll] = docs.length - ids.length;
  }
  const project = await db.get(LEGACY_PROJECT_PATH);
  res.project = project ? 'copied' : 'none';
  if (opts.dryRun) return res;

  let startedAt = existing?.backfill?.startedAt ?? now().toISOString();
  if (!existing) {
    startedAt = now().toISOString();
    const settings: SettingsDoc = {
      ...opts.shared,
      masterDeviceId: self,
      sharedUpdatedAt: startedAt,
      backfill: { by: self, startedAt, state: 'running' },
    };
    if (!(await db.create(SETTINGS_PATH, JSON.parse(JSON.stringify(settings)) as Record<string, unknown>))) {
      // Another run claimed it between the read and the create.
      const now2 = (await db.get(SETTINGS_PATH)) as SettingsDoc | null;
      res.refused = (now2 && refuseFor(now2)) ?? 'meta/settings was created by another run';
      return res;
    }
    log(`claimed meta/settings (master device: ${self})`);
  }

  // 2. Tag the owned docs, ≤ chunk merges per batch.
  for (const coll of OWNED_COLLECTIONS) {
    const ids = untagged.get(coll)!;
    for (let i = 0; i < ids.length; i += chunk) {
      const ops: StoreOp[] = ids.slice(i, i + chunk).map((id) => ({ op: 'merge', path: `${coll}/${id}`, data: { deviceId: self } }));
      await db.write(ops);
      res.batches++;
    }
    if (ids.length) log(`${coll}: tagged ${ids.length} doc(s)`);
  }

  // 3. meta/project → devices/{self}, then delete it.
  const facts: Partial<DeviceDoc> = {
    deviceId: self,
    defaultName: opts.defaultName,
    platform: opts.platform,
    ...(project ? deviceFactsFromProject(project) : {}),
  };
  await db.write([{ op: 'merge', path: `${DEVICES}/${self}`, data: JSON.parse(JSON.stringify(facts)) as Record<string, unknown> }]);
  if (project) {
    await db.write([{ op: 'delete', path: LEGACY_PROJECT_PATH }]);
    log('meta/project copied into devices/' + self + ' and deleted');
  }

  await db.write([
    {
      op: 'merge',
      path: SETTINGS_PATH,
      data: { backfill: { by: self, startedAt, state: 'done', endedAt: now().toISOString() } },
    },
  ]);
  return res;
}
