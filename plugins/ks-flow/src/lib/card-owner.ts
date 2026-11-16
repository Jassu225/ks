// lib/card-owner.ts — which device a card is on, and moving it to this one
// (`ks-flow card-owner` / `ks-flow card-move`, run by ks-start-ticket).
//
// A card moves only when its owner no longer works it: the owner (not
// forgotten) neither lists the card's worktree among its current worktrees nor
// has a Claude session live in it. Otherwise the ticket is still on that
// device and must be removed there first.
import type { DeviceDoc, DeviceStore, WorkUnitDoc } from './db/types.js';

export interface CardOwnerInfo {
  unitId: string;
  /** False when the store has no such card. */
  exists: boolean;
  /** The owner's id, null when the card has none (or doesn't exist). */
  deviceId: string | null;
  /** The owner's name (`name ?? defaultName ?? id`), null without an owner. */
  device: string | null;
  self: string;
  selfName: string;
  /** The owner is this device. */
  local: boolean;
  /** The owner (not forgotten) lists the card's worktree. */
  ownerHasWorktree: boolean;
  /** The card records a live Claude session (written by the owner's daemon). */
  ownerHasLiveSession: boolean;
  ownerLastSeenAt: string | null;
  ownerForgotten: boolean;
}

export function deviceName(d: Pick<DeviceDoc, 'deviceId' | 'name' | 'defaultName'> | null | undefined, id?: string | null): string | null {
  if (d) return d.name || d.defaultName || d.deviceId;
  return id ?? null;
}

/** The card's id as stored: exact, else upper-cased (KAR-123 typed as kar-123). */
async function findCard(store: DeviceStore, unitId: string): Promise<WorkUnitDoc | null> {
  return (await store.getWorkUnit(unitId)) ?? (unitId !== unitId.toUpperCase() ? await store.getWorkUnit(unitId.toUpperCase()) : null);
}

export async function cardOwner(store: DeviceStore, self: { deviceId: string; defaultName: string }, unitId: string): Promise<CardOwnerInfo> {
  const card = await findCard(store, unitId);
  const ownerId = card?.deviceId || null;
  const owner = ownerId ? await store.getDevice(ownerId) : null;
  const selfDoc = await store.getDevice(self.deviceId).catch(() => null);
  const forgotten = owner?.forgotten === true;
  const wt = card?.worktreeDir ?? null;
  return {
    unitId: card?.unitId ?? unitId,
    exists: !!card,
    deviceId: ownerId,
    device: ownerId ? deviceName(owner, ownerId) : null,
    self: self.deviceId,
    selfName: deviceName(selfDoc, null) ?? self.defaultName,
    local: ownerId === self.deviceId,
    ownerHasWorktree: !!(owner && !forgotten && wt && (owner.worktreePaths ?? []).includes(wt)),
    ownerHasLiveSession: !!(owner && !forgotten && (card?.liveSessions?.length ?? 0) > 0),
    ownerLastSeenAt: owner?.lastSeenAt ?? null,
    ownerForgotten: forgotten,
  };
}

export type StartDecision =
  | { action: 'none'; message: string }
  | { action: 'refuse'; message: string }
  | { action: 'move'; message: string };

/** What ks-start-ticket does with the card. */
export function startDecision(info: CardOwnerInfo): StartDecision {
  if (!info.exists) return { action: 'none', message: `${info.unitId} has no card yet` };
  if (!info.deviceId) return { action: 'none', message: `${info.unitId} has no owner yet: this device takes it on its first write` };
  if (info.local) return { action: 'none', message: `${info.unitId} is on this device` };
  if (info.ownerHasWorktree || info.ownerHasLiveSession) {
    return { action: 'refuse', message: `${info.unitId} is on ${info.device}: remove it there first` };
  }
  return { action: 'move', message: `moving ${info.unitId} from ${info.device} to ${info.selfName}` };
}

export interface MoveResult {
  moved: boolean;
  message: string;
  info: CardOwnerInfo;
}

/** Move the card to this device, when startDecision allows it. */
export async function moveCard(store: DeviceStore, self: { deviceId: string; defaultName: string }, unitId: string): Promise<MoveResult> {
  const info = await cardOwner(store, self, unitId);
  const d = startDecision(info);
  if (d.action !== 'move') return { moved: false, message: d.message, info };
  await store.setWorkUnitOwner(info.unitId, self.deviceId);
  return { moved: true, message: d.message, info };
}
