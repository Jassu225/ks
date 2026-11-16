// lib/liveunits.ts — which cards are live (on the board) with several devices.
// Twin of src/lib/liveunits.ts (web can't import src/), plus the board's
// fallback for a store not yet set up for devices.
//
// A card is live when its owner device (not forgotten) lists the card's
// worktree among its current git worktrees (devices/{owner}.worktreePaths).
// Cards of a forgotten device, or whose owner no longer lists the worktree,
// are removed cards: "show removed" / Done, never dropped.
//
// Before the device backfill (no meta/settings) no device records exist: the
// daemon then still nulls a card's worktreeDir once its worktree is gone, so a
// card with a worktreeDir counts as live.
import type { DeviceDoc, WorkUnitDoc } from './types';

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

/** The board's live test: per owner once the store is set up for devices (`setUp`), else the worktreeDir alone. */
export function liveCardTest(
  devices: DeviceDoc[],
  setUp: boolean,
): (u: Pick<WorkUnitDoc, 'deviceId' | 'worktreeDir'>) => boolean {
  if (!setUp) return (u) => !!u.worktreeDir;
  const byId = deviceMap(devices);
  return (u) => isLiveCard(u, byId);
}
