// lib/device-list.ts — `ks-flow devices`: every device on the shared board,
// as JSON rows and as a compact table (device-cli.ts), and the local cache of
// them the daemon keeps.
//
// <dataDir>/devices.json — the daemon writes it on each heartbeat's successful
// read of the devices (write-then-rename), so `ks-flow devices` answers
// instantly and offline:
//   { updatedAt: the last successful store read (ISO),
//     self: this deviceId,
//     devices: [DeviceRow, …] }   (the rows `ks-flow devices --json` prints)
// A reader recomputes `self` and `stale` against now; `--live` reads the store.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceDoc, PeerSession } from './db/types.js';

/** As the board's DeviceChip: a device not seen this long is asleep or offline. */
export const DEVICE_STALE_MS = 5 * 60_000;
export const DEVICES_CACHE_FILE = 'devices.json';

export interface DeviceRow {
  label: string | null;
  /** The user's name for it, else its default name. */
  name: string;
  deviceId: string;
  lastSeenAt: string | null;
  self: boolean;
  master: boolean;
  forgotten: boolean;
  /** Not seen for 5 min (or never). */
  stale: boolean;
  /** Its running Claude sessions as it published them (devices/{id}.sessions; lib/peers.ts). */
  sessions: PeerSession[];
}

export interface DevicesCache {
  updatedAt: string;
  self: string;
  devices: DeviceRow[];
}

/** Published sessions as read back: entries without a session id dropped. */
export function cleanSessions(v: unknown): PeerSession[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is PeerSession => !!s && typeof s === 'object' && typeof (s as PeerSession).sessionId === 'string');
}

function isStale(lastSeenAt: string | null, now: number): boolean {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return !Number.isFinite(seen) || now - seen > DEVICE_STALE_MS;
}

/** `self` and `stale` against this device and now; this device first, then by label (none last), then by id. */
export function refreshRows(rows: readonly DeviceRow[], selfId: string, now: number): DeviceRow[] {
  return rows
    .map((r) => ({ ...r, self: r.deviceId === selfId, stale: isStale(r.lastSeenAt, now) }))
    .sort(
      (a, b) =>
        Number(b.self) - Number(a.self) ||
        Number(a.label === null) - Number(b.label === null) ||
        (a.label ?? '').localeCompare(b.label ?? '', 'en', { numeric: true }) ||
        a.deviceId.localeCompare(b.deviceId),
    );
}

/** One row per device, from the store's docs. */
export function listDevices(
  devices: readonly DeviceDoc[],
  selfId: string,
  masterDeviceId: string | null,
  now: number,
): DeviceRow[] {
  const rows = devices.map(
    (d): DeviceRow => ({
      label: d.label || null,
      name: d.name?.trim() || d.defaultName || d.deviceId.slice(0, 8),
      deviceId: d.deviceId,
      lastSeenAt: d.lastSeenAt || null,
      self: false,
      master: !!masterDeviceId && d.deviceId === masterDeviceId,
      forgotten: d.forgotten === true,
      stale: false,
      sessions: cleanSessions(d.sessions),
    }),
  );
  return refreshRows(rows, selfId, now);
}

/** Write <dataDir>/devices.json (write-then-rename). */
export function writeDevicesCache(dataDir: string, cache: DevicesCache): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DEVICES_CACHE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  renameSync(tmp, path);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** <dataDir>/devices.json, or null when missing or malformed (rows missing an id are dropped). */
export function readDevicesCache(dataDir: string): DevicesCache | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, DEVICES_CACHE_FILE), 'utf8')) as Partial<DevicesCache>;
    const updatedAt = str(j.updatedAt);
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt)) || !Array.isArray(j.devices)) return null;
    const devices: DeviceRow[] = [];
    for (const raw of j.devices as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const deviceId = str(r.deviceId);
      if (!deviceId) continue;
      devices.push({
        label: str(r.label),
        name: str(r.name) ?? deviceId.slice(0, 8),
        deviceId,
        lastSeenAt: str(r.lastSeenAt),
        self: r.self === true,
        master: r.master === true,
        forgotten: r.forgotten === true,
        stale: r.stale === true,
        sessions: cleanSessions(r.sessions),
      });
    }
    return { updatedAt, self: str(j.self) ?? '', devices };
  } catch {
    return null;
  }
}

/** "just now", "12m ago", "3h ago", "2d ago"; "never" without a time. */
export function agoText(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The plain output: an aligned table, this device marked with `*` (its
 * sessions: `ks-flow peers`). `asOf`: the cache's updatedAt (a line
 * says how old it is); null when read from the store.
 */
export function formatDevices(rows: readonly DeviceRow[], now: number, asOf: string | null = null): string {
  const footer = asOf ? `\nas of ${agoText(asOf, now)} (the daemon's last store read; --live reads the store now)` : '';
  if (rows.length === 0) {
    return `No device in the store yet (none has checked in, or the store is not set up for devices).${footer}`;
  }
  const head = ['', 'LABEL', 'NAME', 'DEVICE', 'LAST SEEN', ''];
  const body = rows.map((r) => [
    r.self ? '*' : ' ',
    r.label ?? '-',
    r.name,
    r.deviceId,
    agoText(r.lastSeenAt, now),
    [r.self && 'this device', r.master && 'master', r.forgotten ? 'forgotten' : r.stale && 'stale'].filter(Boolean).join(', '),
  ]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row: string[]): string =>
    row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), ...body.map(line)].join('\n') + footer;
}
