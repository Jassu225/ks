// lib/ownership.ts — card ownership (one ks-flow board for several devices).
//
// A card (workUnits/{unitId}) belongs to the device in its `deviceId`. A
// daemon NEVER writes a card another device owns: no takeover, ever. A ticket
// is worked in one session on one device; the only way a card changes device
// is `ks-flow card-move` (run by ks-start-ticket once the owner has no live
// worktree for it). A card with no owner yet is written, stamped with this
// device. Skipping a card is logged once per card.
//
// The owners are kept in memory: seeded from the cards the daemon reads at
// start, kept current by the store's listener where there is one (another
// device's card-move), and, for a card first seen later, read once. A read that
// fails leaves the card unwritten this time (it is retried on the next
// recompute): offline, a write could otherwise land on top of another
// device's card once the outbox syncs.

export type OwnerLookup = (unitId: string) => Promise<{ exists: boolean; deviceId: string | null }>;

export interface OwnershipDecision {
  write: boolean;
  /** The stored owner when it is another device. */
  owner: string | null;
}

export class CardOwners {
  /** unitId → stored owner (null: the card exists with no owner, or doesn't exist yet). */
  private owners = new Map<string, string | null>();
  private skipped = new Set<string>(); // logged once each
  private readFailed = new Set<string>();

  constructor(
    readonly self: string,
    private lookup: OwnerLookup,
    private log: (msg: string) => void = () => {},
  ) {}

  /** What the store holds (startup read, or the listener's snapshot). */
  seed(cards: Array<{ unitId: string; deviceId?: string | null }>): void {
    for (const c of cards) this.set(c.unitId, c.deviceId ?? null);
  }

  /** One card's stored owner changed (listener, card-move). */
  set(unitId: string, owner: string | null): void {
    this.owners.set(unitId, owner || null);
    if (!owner || owner === this.self) this.skipped.delete(unitId);
  }

  /** The stored owner as known now (undefined: never looked up). */
  known(unitId: string): string | null | undefined {
    return this.owners.get(unitId);
  }

  /** May this daemon write the card? */
  async decide(unitId: string): Promise<OwnershipDecision> {
    if (!this.owners.has(unitId)) {
      try {
        const r = await this.lookup(unitId);
        this.owners.set(unitId, r.exists ? r.deviceId : null);
        this.readFailed.delete(unitId);
      } catch (e) {
        if (!this.readFailed.has(unitId)) {
          this.readFailed.add(unitId);
          this.log(`card ${unitId}: owner unknown (${(e as Error)?.message ?? e}), not writing it until the store answers`);
        }
        return { write: false, owner: null };
      }
    }
    const owner = this.owners.get(unitId) ?? null;
    if (!owner || owner === this.self) return { write: true, owner: null };
    if (!this.skipped.has(unitId)) {
      this.skipped.add(unitId);
      this.log(`card ${unitId} belongs to device ${owner}: this device leaves it alone`);
    }
    return { write: false, owner };
  }

  /** This daemon wrote the card (stamped with itself). */
  wrote(unitId: string): void {
    this.owners.set(unitId, this.self);
  }
}
