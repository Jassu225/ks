// lib/masterFiles.ts — SERVER-only: the master session's files under
// <dataDir>/master/ (docs/briefing.md, "The master"). The board finds the
// master only through these, and asks it for a run or a restart by dropping a
// request file the master's mod picks up.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boardDataDir } from './boardConfig';
import { deviceId, deviceIdentity } from './device';
import { addMasterRequestDoc, getDeviceDoc, getSettingsDoc, serverConfig } from './serverdb';
import type { DeviceDoc, MasterDeviceInfo, MasterHeartbeatFile, MasterRequestDoc, MasterSessionFile, MasterStatus } from './types';

/** No heartbeat for this long while the process lives → 'stale' (it beats every 30 s). */
const STALE_MS = 2 * 60_000;

export type BoardTrigger = 'button' | 'restart';

/** Same defaults as the master mod (plugins/ks-master/hooks/master.ts defaultPrompt). */
const PROMPTS: Record<BoardTrigger, string> = {
  button: '/ks-master:briefing button',
  restart: '/ks-master:restart requested from the board',
};

const masterDir = (): string => join(boardDataDir(), 'master');
const requestsDir = (): string => join(masterDir(), 'requests');

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** A session.json this young with no pid and no process yet is a master still
 * starting (src/lib/master.ts START_GRACE_MS). */
const START_GRACE_MS = 3 * 60_000;

const claudeSessionsDir = (): string => join(homedir(), '.claude', 'sessions');

/** Whether `pid` is a running Claude process: `ps` shows a command containing
 * "claude" — the daemon's test (src/lib/master.ts pidIsClaude), so the board
 * and the daemon agree on whether the master lives (a reused pid fails it). */
function pidIsClaude(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return cmd.includes('claude');
  } catch {
    return false; // ps exits 1 for no such process
  }
}

/** The master's live pid: session.json's when it runs `claude`; else (no pid
 * yet — the mod fills it once loaded) the interactive Claude process with its
 * session id in ~/.claude/sessions/<pid>.json, as the daemon's liveSessions
 * match does. Null when neither runs. */
function livePid(session: MasterSessionFile): number | null {
  if (session.pid) return pidIsClaude(session.pid) ? session.pid : null;
  let names: string[];
  try {
    names = readdirSync(claudeSessionsDir()).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return null;
  }
  for (const n of names) {
    const f = readJson<{ pid?: number; sessionId?: string; kind?: string }>(join(claudeSessionsDir(), n));
    if (f?.kind === 'interactive' && f.sessionId === session.sessionId && typeof f.pid === 'number' && pidIsClaude(f.pid))
      return f.pid;
  }
  return null;
}

/** Pending request files, oldest first (the mod ignores dot-files: our temp
 * names), each with its trigger read from the file — as the daemon does
 * (src/lib/master.ts pendingRequests; the web can't import src, so this is a
 * deliberate copy: keep the two in step). An unreadable file counts with its
 * name's trigger, so it still blocks a duplicate. */
function pendingRequests(): { name: string; trigger: string | null }[] {
  let names: string[];
  try {
    names = readdirSync(requestsDir())
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const raw = readJson<{ trigger?: unknown }>(join(requestsDir(), name));
    const trigger =
      raw && typeof raw.trigger === 'string' ? raw.trigger : (/-([a-z-]+)\.json$/.exec(name)?.[1] ?? null);
    return { name, trigger };
  });
}

/** Remote Control's session id, from Claude Code's own ~/.claude/sessions/<pid>.json. */
function bridgeSessionId(session: MasterSessionFile, pid: number | null): string | null {
  if (!pid) return null;
  const f = readJson<{ sessionId?: string; bridgeSessionId?: string }>(join(claudeSessionsDir(), `${pid}.json`));
  if (!f || typeof f.bridgeSessionId !== 'string' || !f.bridgeSessionId) return null;
  // The pid may have been reused by another Claude process.
  if (f.sessionId && f.sessionId !== session.sessionId) return null;
  return f.bridgeSessionId;
}

const DEFAULT_SCHEDULE = ['00:00', '06:00', '12:00', '18:00'];

/** board-settings.json's `briefing` block, the parts the page shows (src/lib/boardsettings.ts owns it). */
function briefingSchedule(): MasterStatus['briefing'] {
  const s = readJson<{ briefing?: { enabled?: unknown; schedule?: unknown } }>(
    join(boardDataDir(), 'board-settings.json'),
  );
  const b = s?.briefing ?? {};
  const schedule = Array.isArray(b.schedule)
    ? [...new Set(b.schedule.filter((x): x is string => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort()
    : DEFAULT_SCHEDULE;
  return { enabled: b.enabled === true, schedule };
}

export function masterStatus(now = Date.now()): MasterStatus {
  const session = readJson<MasterSessionFile>(join(masterDir(), 'session.json'));
  const heartbeat = readJson<MasterHeartbeatFile>(join(masterDir(), 'heartbeat.json'));
  const pending = pendingRequests().map((r) => r.name);
  const briefing = briefingSchedule();
  if (!session || typeof session.sessionId !== 'string') {
    return {
      state: 'none',
      session: null,
      heartbeat,
      alive: false,
      heartbeatAgeMs: null,
      bridgeSessionId: null,
      pending,
      briefing,
    };
  }
  // Liveness as the daemon judges it (src/daemon.ts masterSuperviseTick): the
  // process, not the heartbeat. A heartbeat counts only when it is this
  // session's — a previous master's last beat says nothing about this one.
  const pid = livePid(session);
  const alive = pid !== null;
  const beat = heartbeat && heartbeat.sessionId === session.sessionId ? heartbeat : null;
  const beatAt = beat?.at ? Date.parse(beat.at) : NaN;
  const heartbeatAgeMs = Number.isFinite(beatAt) ? Math.max(0, now - beatAt) : null;
  const fresh = heartbeatAgeMs != null && heartbeatAgeMs < STALE_MS;
  const startedAt = Date.parse(session.startedAt ?? '');
  const starting = !alive && !session.pid && Number.isFinite(startedAt) && now - startedAt < START_GRACE_MS;
  const state: MasterStatus['state'] = !alive
    ? starting
      ? 'starting'
      : 'down'
    : !fresh
      ? 'stale'
      : beat?.busy
        ? 'busy'
        : 'live';
  return {
    state,
    session,
    heartbeat: beat,
    alive,
    heartbeatAgeMs,
    bridgeSessionId: alive ? bridgeSessionId(session, pid) : null,
    pending,
    briefing,
  };
}

/**
 * "Start master": leave `<masterDir>/start-request.json` for the daemon, which
 * watches for it and launches claude-ks-master --detached within a second
 * (its 60 s tick is the fallback), briefing on or off (src/daemon.ts
 * masterSuperviseTick). The board doesn't launch it
 * itself: the daemon owns that, with its own checks. Refused when a master is
 * running or starting ({ dropped, why }).
 */
export function writeStartRequest(now = Date.now()): { dropped: boolean; why: string } {
  const st = masterStatus(now);
  if (st.alive) return { dropped: true, why: 'the master is already running' };
  if (st.state === 'starting') return { dropped: true, why: 'the master is still starting' };
  const dir = masterDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.start-request.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ v: 1, at: new Date(now).toISOString(), by: 'board' }, null, 2)}\n`);
  renameSync(tmp, join(dir, 'start-request.json'));
  return { dropped: false, why: 'the daemon starts it now' };
}

// ── the master on another device ─────────────────────────────────────────────
// One master, on the device meta/settings.masterDeviceId names. On that device
// the board uses the files above. Elsewhere it reads the status its daemon
// publishes to devices/{master}.master (src/lib/master.ts readMasterStatus,
// the same read as masterStatus() above) and asks through a masterRequests
// doc, which the master device's daemon turns into these files. On PocketBase
// (one device) and before the device backfill, always the local files.

/** The master device's heartbeat older than this: asleep or offline. */
export const DEVICE_OFFLINE_MS = 5 * 60_000;

export type { MasterDeviceInfo };

/** GET /api/briefing/master: the board's MasterStatus, plus where the master runs. */
export type MasterStatusResponse = MasterStatus & { device?: MasterDeviceInfo };

export type MasterTarget =
  | { local: true; masterDeviceId: string | null }
  | { local: false; masterDeviceId: string; self: string; device: DeviceDoc | null };

/** The file mirror's masterDeviceId (the daemon writes it there; src/lib/sharedsettings.ts). */
function mirroredMasterDeviceId(): string | null {
  const s = readJson<{ masterDeviceId?: unknown }>(join(boardDataDir(), 'board-settings.json'));
  return typeof s?.masterDeviceId === 'string' && s.masterDeviceId ? s.masterDeviceId : null;
}

/** Where the master runs, as this board sees it. */
export async function masterTarget(): Promise<MasterTarget> {
  if (serverConfig().dbProvider !== 'firestore') return { local: true, masterDeviceId: null };
  const settings = await getSettingsDoc();
  // Offline with no snapshot: the daemon's mirror in board-settings.json.
  const masterDeviceId = settings === undefined ? mirroredMasterDeviceId() : (settings?.masterDeviceId ?? null);
  const self = deviceId(boardDataDir());
  if (!masterDeviceId || masterDeviceId === self) return { local: true, masterDeviceId };
  const device = await getDeviceDoc(masterDeviceId).catch(() => null);
  return { local: false, masterDeviceId, self, device };
}

function deviceInfo(id: string, d: DeviceDoc | null, remote: boolean, now: number): MasterDeviceInfo {
  const seen = d?.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
  return {
    deviceId: id,
    name: d?.name || d?.defaultName || id,
    remote,
    lastSeenAt: d?.lastSeenAt ?? null,
    offline: remote && (!Number.isFinite(seen) || now - seen > DEVICE_OFFLINE_MS),
  };
}

/** The master's status from what the master device published (devices/{id}.master). */
export function remoteMasterStatus(target: Extract<MasterTarget, { local: false }>, now = Date.now()): MasterStatusResponse {
  const m = (target.device?.master ?? null) as Partial<MasterStatus> & { heartbeatAt?: string | null } | null;
  const beatAt = m?.heartbeatAt ? Date.parse(m.heartbeatAt) : NaN;
  const status: MasterStatus = {
    state: m?.state ?? 'none',
    session: m?.session ?? null,
    heartbeat: m?.heartbeat ?? null,
    alive: m?.alive === true,
    // Recomputed here: the published age is as old as the publish.
    heartbeatAgeMs: Number.isFinite(beatAt) ? Math.max(0, now - beatAt) : (m?.heartbeatAgeMs ?? null),
    bridgeSessionId: m?.bridgeSessionId ?? null,
    pending: Array.isArray(m?.pending) ? m!.pending : [],
    // The shared settings: this device's mirror of meta/settings.
    briefing: briefingSchedule(),
  };
  return { ...status, device: deviceInfo(target.masterDeviceId, target.device, true, now) };
}

/** GET /api/briefing/master's answer, wherever the master runs. */
export async function masterStatusAnywhere(now = Date.now()): Promise<MasterStatusResponse> {
  const target = await masterTarget();
  if (target.local) {
    const st = masterStatus(now);
    return target.masterDeviceId
      ? {
          ...st,
          // This device (its default name: no store read on every poll; the board has its chosen name).
          device: { deviceId: target.masterDeviceId, name: deviceIdentity(boardDataDir()).defaultName, remote: false, lastSeenAt: null, offline: false },
        }
      : st;
  }
  return remoteMasterStatus(target, now);
}

/** Ask the master device's daemon (masterRequests/{uid}); it writes the file this board would have. */
export async function writeRemoteRequest(
  target: Extract<MasterTarget, { local: false }>,
  trigger: 'start' | 'button' | 'restart',
): Promise<MasterRequestDoc> {
  const doc: MasterRequestDoc = { uid: randomUUID(), trigger, from: target.self, createdAt: new Date().toISOString() };
  await addMasterRequestDoc(doc);
  return doc;
}

/**
 * Drop a `button` or `restart` request for the master. One pending request per
 * trigger: when one is already waiting, nothing is written ({dropped: true}).
 * Written to a dot-file first and renamed, so the mod never reads half a file.
 */
export function writeRequest(trigger: BoardTrigger): { file: string | null; dropped: boolean } {
  const dir = requestsDir();
  if (pendingRequests().some((r) => r.trigger === trigger)) return { file: null, dropped: true };
  mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const name = `${createdAt}-${trigger}.json`;
  const body = { v: 1, id: randomUUID(), trigger, slot: null, createdAt, prompt: PROMPTS[trigger] };
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, join(dir, name));
  return { file: name, dropped: false };
}
