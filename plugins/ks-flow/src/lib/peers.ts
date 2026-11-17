// lib/peers.ts — `ks-flow peers`: every running Claude session on every device
// that shares the board, with what it works on and how to message it.
//
// Each daemon reads its own ~/.claude/sessions/<pid>.json records every 15 s
// (lib/claude-sessions.ts readLiveProcesses) and publishes them as
// `devices/{self}.sessions` (PeerSession[]) when anything changed: the peer
// name, Remote Control's id, the card it works on (matched by folder, as the
// card's live sessions are) with the card's title, Claude's busy/idle and
// whether it waits on the person. `ks-flow peers` reads every device and
// prints one table, grouped by device (this one first). A device not seen for
// 5 min is shown with its last-known sessions and "last seen …".
import { basename } from 'node:path';
import type { DeviceDoc, PeerSession, SessionDoc, WorkUnitDoc } from './db/types.js';
import type { LiveProcess } from './claude-sessions.js';
import { sameOrUnder } from './join.js';
import { DEVICE_STALE_MS, agoText, cleanSessions } from './device-list.js';

/** This device's sessions as published: one per live process, oldest first. */
export function peerSessions(
  procs: readonly LiveProcess[],
  cards: readonly Pick<WorkUnitDoc, 'unitId' | 'title' | 'worktreeDir'>[],
  sessionDoc: (sessionId: string) => Pick<SessionDoc, 'waitingTool' | 'waitingSince'> | undefined,
): PeerSession[] {
  return procs
    .map((p): PeerSession => {
      // The longest matching worktree wins (a worktree nested in the checkout).
      const card = cards
        .filter((c) => sameOrUnder(p.cwd, c.worktreeDir ?? null))
        .sort((a, b) => (b.worktreeDir?.length ?? 0) - (a.worktreeDir?.length ?? 0))[0];
      const doc = sessionDoc(p.sessionId);
      return {
        name: p.name?.trim() || null,
        sessionId: p.sessionId,
        bridgeSessionId: p.bridgeSessionId,
        pid: p.pid,
        unitId: card?.unitId ?? null,
        title: card?.title || null,
        folder: basename(p.cwd) || p.cwd,
        tmuxPane: p.tmuxPane,
        startedAt: p.startedAt,
        status: p.status,
        statusAt: p.statusAt,
        waiting: doc?.waitingTool && doc.waitingSince ? { tool: doc.waitingTool, since: doc.waitingSince } : null,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.pid - b.pid);
}

/** One comparable string for "did anything change" (the order is already fixed). */
export function peerSessionsSig(s: readonly PeerSession[] | null | undefined): string {
  return JSON.stringify(s ?? []);
}

export interface PeerDevice {
  deviceId: string;
  label: string | null;
  name: string;
  self: boolean;
  stale: boolean;
  lastSeenAt: string | null;
}

export interface PeerRow {
  device: PeerDevice;
  /** Null: a device with no running session (one row so it still shows). */
  session: PeerSession | null;
  /** working | idle | waiting on you | <Claude's status> | running | last seen … | no sessions */
  state: string;
  /** What to message: `bridge:<id>`; on this device the name works too; null: not reachable. */
  address: string | null;
  /** This is the session asking (its pid is $CLAUDE_PID on this device). */
  you: boolean;
}

/** What the session is doing, in words. */
export function peerState(s: PeerSession, device: PeerDevice, now: number): string {
  if (device.stale) return `last seen ${agoText(device.lastSeenAt, now)}`;
  if (s.waiting) return 'waiting on you';
  if (s.status === 'busy') return 'working';
  if (s.status === 'idle') return 'idle';
  return s.status ?? 'running';
}

/** A device as the store has it, or as the daemon's devices.json cache keeps it. */
export interface PeerSource {
  deviceId: string;
  label?: string | null;
  name?: string | null;
  defaultName?: string;
  lastSeenAt?: string | null;
  forgotten?: boolean;
  sessions?: PeerSession[];
}

/** Rows for every device that isn't forgotten: this one first, then by label, then by id. */
export function peerRows(
  devices: readonly (PeerSource | DeviceDoc)[],
  selfId: string,
  now: number,
  callerPid: number | null = null,
): PeerRow[] {
  const devs = devices
    .filter((d) => d.forgotten !== true)
    .map((d) => {
      const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
      const device: PeerDevice = {
        deviceId: d.deviceId,
        label: d.label || null,
        name: d.name?.trim() || d.defaultName || d.deviceId.slice(0, 8),
        self: d.deviceId === selfId,
        stale: !Number.isFinite(seen) || now - seen > DEVICE_STALE_MS,
        lastSeenAt: d.lastSeenAt || null,
      };
      return { device, sessions: cleanSessions(d.sessions) };
    })
    .sort(
      (a, b) =>
        Number(b.device.self) - Number(a.device.self) ||
        Number(a.device.label === null) - Number(b.device.label === null) ||
        (a.device.label ?? '').localeCompare(b.device.label ?? '', 'en', { numeric: true }) ||
        a.device.deviceId.localeCompare(b.device.deviceId),
    );
  const rows: PeerRow[] = [];
  for (const { device, sessions } of devs) {
    if (sessions.length === 0) {
      rows.push({
        device,
        session: null,
        state: device.stale ? `last seen ${agoText(device.lastSeenAt, now)}` : 'no sessions',
        address: null,
        you: false,
      });
      continue;
    }
    for (const s of sessions) {
      rows.push({
        device,
        session: s,
        state: peerState(s, device, now),
        address: s.bridgeSessionId ? `bridge:${s.bridgeSessionId}` : device.self && s.name ? s.name : null,
        you: device.self && callerPid !== null && s.pid === callerPid,
      });
    }
  }
  return rows;
}

const deviceText = (d: PeerDevice): string => `${d.label ? `${d.label} · ` : ''}${d.name}${d.self ? ' (this Mac)' : ''}`;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const peerName = (r: PeerRow): string => (r.session ? `${r.session.name ?? `(unnamed, ${r.session.folder})`}${r.you ? ' (you)' : ''}` : '—');
const titleText = (s: PeerSession | null): string =>
  !s ? '' : s.title ?? (s.name === 'ks-master' ? 'master session' : `folder ${s.folder}`);

/** The table as Markdown: what an agent shows the person as is. */
export function formatPeersMarkdown(rows: readonly PeerRow[], now: number): string {
  if (rows.length === 0) return 'No device on the board yet.';
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const out = ['| Device | Peer | Ticket | Title | State | Address | Pane | Started |', '|---|---|---|---|---|---|---|---|'];
  let last = '';
  for (const r of rows) {
    const dev = r.device.deviceId === last ? '' : deviceText(r.device);
    last = r.device.deviceId;
    const s = r.session;
    out.push(
      `| ${[
        esc(dev),
        s ? `\`${esc(peerName(r))}\`` : '—',
        s?.unitId ?? '—',
        esc(cut(titleText(s), 60)),
        r.state,
        r.address ? `\`${r.address}\`` : s ? (r.device.self ? '— (unnamed)' : '— (no Remote Control)') : '',
        s?.tmuxPane ?? '—',
        s ? agoText(s.startedAt, now) : '',
      ].join(' | ')} |`,
    );
  }
  return out.join('\n');
}

/** The table as aligned text, for a terminal. */
export function formatPeers(rows: readonly PeerRow[], now: number, asOf: string | null = null): string {
  const footer = asOf ? `\nas of ${agoText(asOf, now)} (the daemon's cache: the store could not be read)` : '';
  if (rows.length === 0) return `No device on the board yet.${footer}`;
  const head = ['DEVICE', 'PEER', 'TICKET', 'TITLE', 'STATE', 'ADDRESS', 'PANE', 'STARTED'];
  let last = '';
  const body = rows.map((r) => {
    const dev = r.device.deviceId === last ? '' : deviceText(r.device);
    last = r.device.deviceId;
    const s = r.session;
    return [
      dev,
      peerName(r),
      s?.unitId ?? (s ? '-' : ''),
      cut(titleText(s), 40),
      r.state,
      r.address ?? (s ? '-' : ''),
      s?.tmuxPane ?? (s ? '-' : ''),
      s ? agoText(s.startedAt, now) : '',
    ];
  });
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), ...body.map(line)].join('\n') + footer;
}
