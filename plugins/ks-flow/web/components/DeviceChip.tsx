'use client';
// DeviceChip — which device a card, a backup run or a master event belongs to.
//
// One board for several devices (any number): the chip names the device (your
// name for it, else its default name), coloured from a fixed palette by a
// stable hash of its id, so every board picks the same colour for it. Two ids
// that land on one colour still differ by name.
//
// It shows only where it tells you something, and not at all while fewer than
// two (non-forgotten) devices exist. A device not seen for 5 min (asleep or
// offline) dims, with "<name>: last seen <ago>"; a forgotten one is struck
// through ("removed device").
import { useShared } from '@/lib/boardData';
import type { DeviceDoc } from '@/lib/types';

/** A device not heard from for this long is asleep or offline. */
export const DEVICE_STALE_MS = 5 * 60_000;
/** The master device stale this long: Settings asks for a new master. */
export const MASTER_STALE_WARN_MS = 60 * 60_000;

// Full class strings (Tailwind only keeps classes it sees written out).
const PALETTE = [
  'border-sky-800 bg-sky-950 text-sky-300',
  'border-emerald-800 bg-emerald-950 text-emerald-300',
  'border-violet-800 bg-violet-950 text-violet-300',
  'border-amber-800 bg-amber-950 text-amber-300',
  'border-rose-800 bg-rose-950 text-rose-300',
  'border-teal-800 bg-teal-950 text-teal-300',
  'border-fuchsia-800 bg-fuchsia-950 text-fuchsia-300',
  'border-lime-800 bg-lime-950 text-lime-300',
  'border-orange-800 bg-orange-950 text-orange-300',
  'border-cyan-800 bg-cyan-950 text-cyan-300',
  'border-indigo-800 bg-indigo-950 text-indigo-300',
  'border-pink-800 bg-pink-950 text-pink-300',
] as const;

/** FNV-1a over the id: the same palette slot on every board. */
export function deviceColorIndex(deviceId: string, size: number = PALETTE.length): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % size;
}

export function deviceColorClass(deviceId: string): string {
  return PALETTE[deviceColorIndex(deviceId)];
}

/** Your name for the device, else its default name, else its short id. */
export function deviceLabel(d: Pick<DeviceDoc, 'name' | 'defaultName'> | null | undefined, deviceId: string): string {
  return d?.name?.trim() || d?.defaultName || deviceId.slice(0, 8);
}

/** Asleep or offline: not seen for 5 min (or never). */
export function isDeviceStale(
  d: Pick<DeviceDoc, 'lastSeenAt'> | null | undefined,
  now: number,
  ms: number = DEVICE_STALE_MS,
): boolean {
  const t = d?.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
  return !Number.isFinite(t) || now - t > ms;
}

/** "just now", "12m ago", "3h ago", "2d ago"; "never" without a time. */
export function agoText(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Chips show only once there are two or more devices (forgotten ones don't count). */
export function showDeviceChips(devices: Pick<DeviceDoc, 'forgotten'>[]): boolean {
  return devices.filter((d) => d.forgotten !== true).length >= 2;
}

export function DeviceChip({
  deviceId,
  prefix = '',
  always = false,
  className = '',
}: {
  /** The device; absent = this device (a record from before the device backfill). */
  deviceId?: string | null;
  /** Text before the name ("this device: "). */
  prefix?: string;
  /** Show it even with one device (Settings → Devices lists them all). */
  always?: boolean;
  className?: string;
}) {
  const { board, now } = useShared();
  if (!always && !showDeviceChips(board.devices)) return null;
  const id = deviceId || board.self;
  const d = board.devices.find((x) => x.deviceId === id) ?? null;
  const name = deviceLabel(d, id);
  const forgotten = d?.forgotten === true;
  const stale = !forgotten && isDeviceStale(d, now);
  const title = forgotten
    ? `${name}: removed device (forgotten in Settings → Devices) · last seen ${agoText(d?.lastSeenAt, now)}`
    : stale
      ? `${name}: last seen ${agoText(d?.lastSeenAt, now)}`
      : `${name}${id === board.self ? ' (this device)' : ''} · seen ${agoText(d?.lastSeenAt, now)}`;
  const look = forgotten
    ? 'border-slate-700 bg-slate-900 text-slate-500 line-through'
    : `${deviceColorClass(id)} ${stale ? 'opacity-50' : ''}`;
  return (
    <span
      className={`inline-block max-w-[10rem] shrink-0 truncate rounded border px-1.5 py-0.5 text-[10px] font-medium ${look} ${className}`}
      title={title}
    >
      {prefix}
      {name}
    </span>
  );
}
