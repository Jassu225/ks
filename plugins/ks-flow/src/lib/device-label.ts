// lib/device-label.ts — each device's short label on the shared board (A, B,
// C…), so Claude sessions can be named `<label>:<unit>` (B:KAR-123) and peers
// listed per device. web/lib/device-label.ts is its twin: keep the two
// identical apart from this header (no imports, so both build it as is).
//
// A label is 1–3 characters, uppercase A–Z / 0–9, starting with a letter, and
// unique among the devices not forgotten. It lives in devices/{id}.label:
//   - the daemon assigns one on its heartbeat when its device has none (or an
//     invalid one): the lowest free of A..Z, then A2..Z2, A3..Z3, …;
//   - two devices on one label (two new devices picking at once, a forgotten
//     device taken back): one keeps it — the master device
//     (meta/settings.masterDeviceId), else the smaller deviceId — and the
//     other picks again on its next heartbeat;
//   - a valid label no other live device holds is never changed: the user sets
//     labels in Settings → Devices (which refuses a duplicate).

/** The fields of a device this module reads (a DeviceDoc fits). */
export interface LabelDevice {
  deviceId: string;
  label?: string | null;
  name?: string | null;
  forgotten?: boolean;
}

export const LABEL_MAX = 3;
const LABEL_RE = /^[A-Z][A-Z0-9]{0,2}$/;

/** 1–3 characters, uppercase A–Z / 0–9, starting with a letter. */
export function isValidLabel(v: unknown): v is string {
  return typeof v === 'string' && LABEL_RE.test(v);
}

/** What the user typed, as a label would be stored: trimmed, uppercase. */
export function normalizeLabel(v: string): string {
  return v.trim().toUpperCase();
}

/** Why a typed label is refused, or null when it is fine ('' = no label: the daemon assigns one). */
export function labelFormatError(v: string): string | null {
  const l = normalizeLabel(v);
  if (l === '' || LABEL_RE.test(l)) return null;
  if (l.length > LABEL_MAX) return `A label is at most ${LABEL_MAX} characters.`;
  if (!/^[A-Z]/.test(l)) return 'A label starts with a letter.';
  return 'A label is letters A–Z and digits 0–9 only.';
}

/** The devices that count for uniqueness: not forgotten. */
export function liveDevices<T extends LabelDevice>(devices: readonly T[]): T[] {
  return devices.filter((d) => d.forgotten !== true);
}

/** The live device other than `deviceId` that holds `label`, or null. */
export function labelHolder<T extends LabelDevice>(devices: readonly T[], deviceId: string, label: string): T | null {
  return liveDevices(devices).find((d) => d.deviceId !== deviceId && d.label === label) ?? null;
}

/** A..Z, then A2..Z2, A3..Z3, … A99..Z99. */
export function* labelCandidates(): Generator<string> {
  for (let n = 1; n <= 99; n++) {
    for (let c = 0; c < 26; c++) yield String.fromCharCode(65 + c) + (n === 1 ? '' : String(n));
  }
}

/** The first candidate not in `taken` (null only past Z99). */
export function nextFreeLabel(taken: Iterable<string>): string | null {
  const used = new Set(taken);
  for (const l of labelCandidates()) if (!used.has(l)) return l;
  return null;
}

/** Of devices sharing one label, the one that keeps it: the master device, else the smaller deviceId. */
export function labelKeeper(holderIds: readonly string[], masterDeviceId: string | null | undefined): string {
  if (masterDeviceId && holderIds.includes(masterDeviceId)) return masterDeviceId;
  return [...holderIds].sort()[0];
}

export interface SelfLabelPlan {
  /** This device's label once the plan is written (null only when every candidate is taken). */
  label: string | null;
  /** The label changed: merge `{ label }` into devices/{self}. */
  write: boolean;
  /** The user's name for this device (Settings → Devices), or null. */
  name: string | null;
  /** Devices not forgotten (this device counted even before its doc is read back). */
  deviceCount: number;
}

/**
 * The daemon's heartbeat: what this device's label should be, given every
 * device in the store. Keeps a valid label no other live device holds (or one
 * this device keeps by the master / smaller-id rule); else picks the lowest
 * free one.
 */
export function planSelfLabel(
  selfId: string,
  devices: readonly LabelDevice[],
  masterDeviceId: string | null | undefined,
): SelfLabelPlan {
  const self = devices.find((d) => d.deviceId === selfId);
  const others = liveDevices(devices).filter((d) => d.deviceId !== selfId);
  const deviceCount = liveDevices(devices).length + (self ? 0 : 1);
  const name = self?.name?.trim() || null;
  const current = self?.label;
  if (isValidLabel(current)) {
    const holders = others.filter((d) => d.label === current).map((d) => d.deviceId);
    if (holders.length === 0 || labelKeeper([selfId, ...holders], masterDeviceId) === selfId) {
      return { label: current, write: false, name, deviceCount };
    }
  }
  const label = nextFreeLabel(others.map((d) => d.label).filter(isValidLabel));
  return { label, write: label !== (current ?? null), name, deviceCount };
}
