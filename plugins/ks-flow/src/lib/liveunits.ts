// lib/liveunits.ts — which cards are live (on the board) with several devices.
// The board's twin is web/lib/liveunits.ts.
//
// A card is live when its owner device (not forgotten) lists the card's
// worktree among its current git worktrees (devices/{owner}.worktreePaths).
// A card with no owner yet (before the device backfill) falls back to the
// retired meta/project's worktreePaths when that still exists.
import type { DeviceDoc, WorkUnitDoc } from './db/types.js';

export type DeviceMap = ReadonlyMap<string, Pick<DeviceDoc, 'worktreePaths' | 'forgotten'>>;

export function deviceMap(devices: DeviceDoc[]): Map<string, DeviceDoc> {
  return new Map(devices.map((d) => [d.deviceId, d]));
}

/** The card's worktree is live on its owner device. */
export function isLiveCard(
  u: Pick<WorkUnitDoc, 'deviceId' | 'worktreeDir'>,
  devices: DeviceMap,
  legacyWorktrees: ReadonlySet<string> | null = null,
): boolean {
  if (!u.worktreeDir) return false;
  if (!u.deviceId) return !!legacyWorktrees?.has(u.worktreeDir);
  const d = devices.get(u.deviceId);
  return !!d && d.forgotten !== true && (d.worktreePaths ?? []).includes(u.worktreeDir);
}
