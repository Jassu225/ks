// lib/versioning.ts — which ks-flow every device runs, against the store's
// (README "Versioning"). Pure, plus the local status file.
//
// meta/settings holds two numbers:
//   schemaVersion  an integer, raised only by a change that breaks older code
//                  (SCHEMA_VERSION below). A device whose code is older is
//                  BEHIND ON THE DATA FORMAT: its daemon drops every store write
//                  (never queued: replaying old-format writes after the update
//                  would undo the new format) and its board goes read-only.
//   version        the release: ks-flow's plugin.json version (semver). A device
//                  behind only on this keeps working, shows a banner and updates.
// plus versionBy (deviceId) and versionAt. A daemon running newer code raises
// them on start, in a transaction, only upward; a dev build (a clone not on
// main, or with uncommitted changes) never does.
//
// <dataDir>/version-status.json is this device's view, written by its daemon:
// the board (read-only flag, banner), the SessionStart hook, `ks-setup doctor`
// and every store writer in this device's processes (the write gate) read it.
//
// The store only says another device runs something newer. A new KS release
// is found by the daemon itself: at most hourly (decideRelease) it runs ks's
// `ks-setup update --check --json`, keeps the answer in
// <dataDir>/release-check.json, and when it says "available" starts the same
// `ks-flow update` it starts for a store that is ahead.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The data format this code writes. Raise it only for a change older code would break. */
export const SCHEMA_VERSION = 1;

export const VERSION_STATUS_FILE = 'version-status.json';
export const UPDATE_STATE_FILE = 'update-state.json';
/** Auto-update tries at most this often. */
export const UPDATE_RETRY_MS = 60 * 60_000;
/** After "busy" (another update held ks-setup's lock), the next try waits this long. */
export const UPDATE_BUSY_RETRY_MS = 10 * 60_000;
export const RELEASE_CHECK_FILE = 'release-check.json';
/** The release check runs at most this often. */
export const RELEASE_CHECK_MS = 60 * 60_000;
/** After a check that found ks-setup busy, the next one waits this long. */
export const RELEASE_BUSY_RETRY_MS = 10 * 60_000;

// ── semver ──────────────────────────────────────────────────────────────────

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(v: unknown): Semver | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1, by semver precedence (a pre-release sorts before its release).
 * Something that isn't semver sorts before any version; two such are equal. */
export function compareSemver(a: unknown, b: unknown): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ── code vs store ───────────────────────────────────────────────────────────

/** What this device runs. */
export interface CodeVersion {
  version: string;
  schemaVersion: number;
  /** A clone not on main, or with uncommitted changes: never raises, never auto-updates. */
  dev: boolean;
  devReason: string | null;
}

/** meta/settings' version fields. */
export interface StoreVersion {
  schemaVersion?: number | null;
  version?: string | null;
  versionBy?: string | null;
  versionAt?: string | null;
}

const storeSchema = (s: StoreVersion | null | undefined): number =>
  typeof s?.schemaVersion === 'number' && Number.isFinite(s.schemaVersion) ? s.schemaVersion : 0;

/**
 * The merge that raises meta/settings to this code, or null: only upward,
 * never from a dev build, and never onto a store with no meta/settings (that
 * is the device backfill's to create).
 */
export function raisePatch(store: StoreVersion | null, code: CodeVersion, by: string, at: string): StoreVersion | null {
  if (code.dev || !store) return null;
  const patch: StoreVersion = {};
  if (code.schemaVersion > storeSchema(store)) patch.schemaVersion = code.schemaVersion;
  if (parseSemver(code.version) && compareSemver(code.version, store.version) > 0) patch.version = code.version;
  if (Object.keys(patch).length === 0) return null;
  return { ...patch, versionBy: by, versionAt: at };
}

export interface Standing {
  storeVersion: string | null;
  storeSchemaVersion: number;
  /** The store's release is newer than this code's. */
  versionBehind: boolean;
  /** The store's data format is newer than this code's: no store writes here. */
  schemaBehind: boolean;
}

export function standing(store: StoreVersion | null, code: CodeVersion): Standing {
  const storeVersion = typeof store?.version === 'string' && store.version ? store.version : null;
  const storeSchemaVersion = storeSchema(store);
  return {
    storeVersion,
    storeSchemaVersion,
    versionBehind: !!storeVersion && compareSemver(storeVersion, code.version) > 0,
    schemaBehind: storeSchemaVersion > code.schemaVersion,
  };
}

// ── the update's own record (written by `ks-flow update`) ───────────────────

export interface UpdateState {
  /** busy: another update held ks-setup's lock, nothing was done (retried after UPDATE_BUSY_RETRY_MS). */
  state: 'running' | 'ok' | 'failed' | 'refused' | 'busy';
  startedAt: string;
  endedAt?: string | null;
  from?: string | null;
  to?: string | null;
  /** Why it failed or was refused. */
  reason?: string | null;
  pid?: number | null;
  /** auto: started by the daemon; manual: `ks-flow update` by hand. */
  by?: 'auto' | 'manual';
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readUpdateState(dataDir: string): UpdateState | null {
  return readJson<UpdateState>(join(dataDir, UPDATE_STATE_FILE));
}

export function writeUpdateState(dataDir: string, s: UpdateState): void {
  writeJsonAtomic(join(dataDir, UPDATE_STATE_FILE), s);
}

/**
 * May the daemon start `ks-flow update` now? Not while one runs (its pid is
 * alive), and not within an hour of the last try, whatever its outcome; after
 * "busy" (another update held the lock), ten minutes after it.
 */
export function mayAutoUpdate(last: UpdateState | null, now: number, alive: (pid: number) => boolean): boolean {
  if (!last) return true;
  if (last.state === 'running' && last.pid && alive(last.pid)) return false;
  if (last.state === 'busy') {
    const b = Date.parse(last.endedAt ?? last.startedAt);
    return !Number.isFinite(b) || now - b >= UPDATE_BUSY_RETRY_MS;
  }
  const t = Date.parse(last.startedAt);
  return !Number.isFinite(t) || now - t >= UPDATE_RETRY_MS;
}

// ── the release check (`ks-setup update --check --json`, run by the daemon) ─

/** One KS plugin as the check saw it: the oldest installed copy and the newest release. */
export interface ReleasePlugin {
  plugin: string;
  installed: string | null;
  latest: string | null;
}

/** VersionStatus.release: the last check's answer (`ks-setup doctor`'s ks-flow:release line reads it). */
export interface ReleaseStatus {
  checkedAt: string;
  state: 'available' | 'current' | 'failed' | 'refused';
  plugins: ReleasePlugin[];
  /** Why it failed or was refused. */
  reason: string | null;
}

/** <dataDir>/release-check.json: the last answer, plus when ks-setup was last found busy. */
export interface ReleaseCheck {
  /** null: no answer yet (only "busy" so far). */
  checkedAt: string | null;
  state: ReleaseStatus['state'] | 'busy';
  plugins: ReleasePlugin[];
  reason: string | null;
  /** The last try found another update holding ks-setup's lock (the answer above is kept). */
  busyAt?: string | null;
}

export function readReleaseCheck(dataDir: string): ReleaseCheck | null {
  return readJson<ReleaseCheck>(join(dataDir, RELEASE_CHECK_FILE));
}

export function writeReleaseCheck(dataDir: string, c: ReleaseCheck): void {
  writeJsonAtomic(join(dataDir, RELEASE_CHECK_FILE), c);
}

const updateRunning = (u: UpdateState | null, alive: (pid: number) => boolean): boolean =>
  u?.state === 'running' && !!u.pid && alive(u.pid);

/** An update finished well after the check: its answer no longer holds (re-checked at once). */
function checkOutdated(c: ReleaseCheck, update: UpdateState | null): boolean {
  if (update?.state !== 'ok') return false;
  const ended = Date.parse(update.endedAt ?? '');
  const at = Date.parse(c.checkedAt ?? '');
  return Number.isFinite(ended) && Number.isFinite(at) && ended > at;
}

/**
 * Run the release check now? Never from a dev build (it never updates
 * itself), never while an update runs; at most hourly, but at once after an
 * update succeeded (the last answer is out of date), and ten minutes after
 * ks-setup was found busy.
 */
export function decideRelease(
  prev: ReleaseCheck | null,
  now: number,
  code: CodeVersion,
  update: UpdateState | null,
  alive: (pid: number) => boolean = () => true,
): boolean {
  if (code.dev) return false;
  if (updateRunning(update, alive)) return false;
  if (!prev) return true;
  const busy = Date.parse(prev.busyAt ?? '');
  if (Number.isFinite(busy) && now - busy < RELEASE_BUSY_RETRY_MS) return false;
  const at = Date.parse(prev.checkedAt ?? '');
  if (!Number.isFinite(at)) return true;
  if (checkOutdated(prev, update)) return true;
  return now - at >= RELEASE_CHECK_MS;
}

/** What `ks-setup update --check --json` printed (its JSON line, parsed), as the record to keep. */
export function releaseCheckFrom(
  r: { code: number; json: { state?: string; plugins?: { plugin?: string; from?: string | null; to?: string | null }[]; reason?: string | null } | null; out: string },
  prev: ReleaseCheck | null,
  now: string,
): ReleaseCheck {
  const j = r.json;
  if (r.code === 3 || j?.state === 'busy') {
    return { ...(prev ?? { checkedAt: null, state: 'busy', plugins: [], reason: j?.reason ?? 'another update is running' }), busyAt: now };
  }
  const plugins: ReleasePlugin[] = (j?.plugins ?? [])
    .filter((p) => typeof p?.plugin === 'string' && p.plugin)
    .map((p) => ({ plugin: p.plugin as string, installed: p.from ?? null, latest: p.to ?? null }));
  const known = j?.state === 'available' || j?.state === 'current' || j?.state === 'failed' || j?.state === 'refused';
  if (j && known) return { checkedAt: now, state: j.state as ReleaseStatus['state'], plugins, reason: j.reason ?? null };
  const tail = r.out.trim().split('\n').slice(-2).join(' | ').slice(-300);
  const reason =
    r.code === 2
      ? 'this ks has no `ks-setup update --check` (an older ks)'
      : `ks-setup update --check gave no result (exit ${r.code})${tail ? `: ${tail}` : ''}`;
  return { checkedAt: now, state: r.code === 2 ? 'refused' : 'failed', plugins, reason };
}

/** The plugins the release brings: newer than the copy installed. */
export function newInRelease(r: Pick<ReleaseStatus, 'plugins'> | null | undefined): ReleasePlugin[] {
  return (r?.plugins ?? []).filter((p) => p.latest && compareSemver(p.latest, p.installed) > 0);
}

/**
 * The release status this device shows: the last answer, or null (no answer
 * yet, a dev build, or an update succeeded since: the answer is out of date).
 */
export function currentRelease(c: ReleaseCheck | null, update: UpdateState | null, code: Pick<CodeVersion, 'dev'>): ReleaseStatus | null {
  if (!c || code.dev || !c.checkedAt || c.state === 'busy') return null;
  if (checkOutdated(c, update)) return null;
  return { checkedAt: c.checkedAt, state: c.state, plugins: c.plugins ?? [], reason: c.reason ?? null };
}

// ── this device's status file ───────────────────────────────────────────────

export interface VersionStatus {
  deviceId: string;
  deviceName: string;
  /** This code's release and data format. */
  version: string;
  schemaVersion: number;
  dev: boolean;
  devReason: string | null;
  /** How this ks-flow was installed: the update's path. */
  mode: 'marketplace' | 'clone' | 'unknown';
  /** meta/settings' numbers (null / 0 before the device backfill, or before the first read). */
  storeVersion: string | null;
  storeSchemaVersion: number;
  versionBehind: boolean;
  schemaBehind: boolean;
  /** No store writes from this device (its daemon drops them; its board answers 409). */
  readOnly: boolean;
  update: UpdateState | null;
  /** The daemon's last release check (`ks-setup update --check`); null: none, out of date, or a dev build. */
  release: ReleaseStatus | null;
  /** The notice last sent for this state (so a restart doesn't repeat it). */
  notified?: string | null;
  updatedAt: string;
}

export function readVersionStatus(dataDir: string): VersionStatus | null {
  return readJson<VersionStatus>(join(dataDir, VERSION_STATUS_FILE));
}

export function writeVersionStatus(dataDir: string, s: VersionStatus): void {
  writeJsonAtomic(join(dataDir, VERSION_STATUS_FILE), s);
  blockCache.delete(dataDir);
}

/** The reason store writes are off on this device, for a log line or a 409. */
export function readOnlyReason(s: Pick<VersionStatus, 'readOnly' | 'schemaVersion' | 'storeSchemaVersion'> | null): string | null {
  if (!s?.readOnly) return null;
  return `ks-flow on this device is behind on the data format (schema ${s.schemaVersion} < ${s.storeSchemaVersion}): store writes are off until it updates (ks-flow update)`;
}

const blockCache = new Map<string, { mtimeMs: number; reason: string | null }>();

/**
 * The write gate: why this device may not write the store now, or null. Read
 * from the status file (cached on its mtime, so a writer may call it on every
 * write), so every process of this device — daemon, backup CLI, Briefing CLI —
 * stops together.
 */
export function storeWriteBlock(dataDir: string): string | null {
  const path = join(dataDir, VERSION_STATUS_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    blockCache.delete(dataDir);
    return null;
  }
  const hit = blockCache.get(dataDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.reason;
  const reason = readOnlyReason(readVersionStatus(dataDir));
  blockCache.set(dataDir, { mtimeMs, reason });
  return reason;
}

/**
 * The status a daemon starts with, before it has read meta/settings: the last
 * file's read-only flag is kept only while the code is the same (still behind);
 * new code starts writable and finds out on its first read.
 */
export function startupStatus(prev: VersionStatus | null, base: Omit<VersionStatus, 'storeVersion' | 'storeSchemaVersion' | 'versionBehind' | 'schemaBehind' | 'readOnly' | 'updatedAt'>, now: string): VersionStatus {
  const same = !!prev && prev.version === base.version && prev.schemaVersion === base.schemaVersion;
  const keep = same && prev ? prev : null;
  const st = keep ? standing({ version: keep.storeVersion, schemaVersion: keep.storeSchemaVersion }, base) : null;
  return {
    ...base,
    storeVersion: keep?.storeVersion ?? null,
    storeSchemaVersion: keep?.storeSchemaVersion ?? 0,
    versionBehind: st?.versionBehind ?? false,
    schemaBehind: st?.schemaBehind ?? false,
    readOnly: st?.schemaBehind ?? false,
    notified: keep?.notified ?? null,
    updatedAt: now,
  };
}

/** One line on this device's state, or null when it is up to date (macOS notice, SessionStart, doctor). */
export function behindMessage(
  s: Pick<VersionStatus, 'deviceName' | 'version' | 'storeVersion' | 'schemaVersion' | 'storeSchemaVersion' | 'versionBehind' | 'schemaBehind' | 'dev' | 'devReason' | 'update'> & {
    release?: ReleaseStatus | null;
  },
  willUpdate: boolean,
): string | null {
  const failed = s.update && (s.update.state === 'failed' || s.update.state === 'refused') ? (s.update.reason ?? 'see update.log') : null;
  // Another update holds ks-setup's lock: this device is being updated.
  const updating = willUpdate || (!s.dev && s.update?.state === 'busy');
  const fresh = s.release?.state === 'available' ? newInRelease(s.release) : [];
  if (!s.versionBehind && !s.schemaBehind) {
    if (fresh.length) {
      // The target is in the head (before ": "), so a newer release is a new notice.
      const what = `a new KS release on ${s.deviceName} (${fresh.map((p) => `${p.plugin} ${p.latest}`).join(', ')})`;
      if (updating) return `${what}: updating`;
      const why = failed ?? (s.update?.state === 'ok' ? 'the last update did not bring it up to date' : 'update by hand');
      return `${what}: run \`ks-setup update\` (${why})`;
    }
    if (failed) return `ks-flow on ${s.deviceName} could not update: run \`ks-flow update\` (${failed})`;
    return null;
  }
  const what = s.versionBehind
    ? `is behind (${s.version} → ${s.storeVersion})`
    : `is behind on the data format (schema ${s.schemaVersion} → ${s.storeSchemaVersion})`;
  const ro = s.schemaBehind ? '; its board is read-only' : '';
  if (updating) return `ks-flow on ${s.deviceName} ${what}${ro}: updating`;
  const reason = s.dev
    ? `dev build: ${s.devReason ?? 'not a release'}`
    : (failed ?? (s.update?.state === 'ok' ? 'the last update did not bring it up to date' : 'update by hand'));
  return `ks-flow on ${s.deviceName} ${what}${ro}: run \`ks-flow update\` (${reason})`;
}

/** What the daemon does with a fresh read of meta/settings (or its heartbeat). */
export interface VersionDecision {
  status: VersionStatus;
  /** A macOS notice to send now (a new state), or null. */
  notice: string | null;
  /** Start `ks-flow update` now. */
  launchUpdate: boolean;
}

export function decideVersion(input: {
  prev: VersionStatus;
  settings: StoreVersion | null;
  code: CodeVersion;
  mode: VersionStatus['mode'];
  update: UpdateState | null;
  /** The daemon's last release check (release-check.json); absent: none. */
  release?: ReleaseCheck | null;
  now: number;
  alive: (pid: number) => boolean;
}): VersionDecision {
  const { prev, code, mode, update, now, alive } = input;
  const release = currentRelease(input.release ?? null, update, code);
  // No meta/settings yet (before the backfill, or not read): keep what is known.
  const st = input.settings
    ? standing(input.settings, code)
    : { storeVersion: prev.storeVersion, storeSchemaVersion: prev.storeSchemaVersion, versionBehind: prev.versionBehind, schemaBehind: prev.schemaBehind };
  // Behind the store, or a new release the check found.
  const behind = st.versionBehind || st.schemaBehind || (release?.state === 'available' && newInRelease(release).length > 0);
  // A dev build never updates itself; nor does a folder that is neither a clone nor an install.
  const canAuto = behind && !code.dev && mode !== 'unknown';
  const running = updateRunning(update, alive);
  const launchUpdate = canAuto && !running && mayAutoUpdate(update, now, alive);
  const status: VersionStatus = {
    ...prev,
    version: code.version,
    schemaVersion: code.schemaVersion,
    dev: code.dev,
    devReason: code.devReason,
    mode,
    ...st,
    readOnly: st.schemaBehind,
    update,
    release,
    updatedAt: new Date(now).toISOString(),
  };
  const msg = behindMessage(status, launchUpdate || running);
  // One notice per state: "updating" once per target (an hourly retry after a
  // failure says nothing new), and each different failure once.
  const head = (m: string): string => m.split(': ')[0];
  let notice: string | null = null;
  let notified = prev.notified ?? null;
  if (!msg) notified = null;
  else if (msg.endsWith(': updating')) {
    if (!notified || head(notified) !== head(msg)) notice = notified = msg;
  } else if (msg !== notified) notice = notified = msg;
  status.notified = notified;
  return { status, notice, launchUpdate };
}
