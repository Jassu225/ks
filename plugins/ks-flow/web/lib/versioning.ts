// lib/versioning.ts — the board's side of versioning (src/lib/versioning.ts
// has the rules; README "Versioning"). Pure: the header's banner uses it in the
// browser. compareSemver is a twin of the daemon's; keep the two in step.
import type { DeviceDoc, SettingsDoc, VersionStatus } from './types';

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

function parseSemver(v: unknown): Semver | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1 by semver precedence; something that isn't semver sorts first. */
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

export interface VersionNotice {
  key: string;
  /** red: this board is read-only · amber: a device is behind or an update failed. */
  tone: 'red' | 'amber';
  text: string;
}

const nameOf = (d: Pick<DeviceDoc, 'name' | 'defaultName'> | null | undefined, id: string): string =>
  d?.name?.trim() || d?.defaultName || id.slice(0, 8);

const failedReason = (s: VersionStatus | null): string | null =>
  s?.update && (s.update.state === 'failed' || s.update.state === 'refused') ? (s.update.reason ?? 'see update.log') : null;

/**
 * The banner's lines: this board read-only (behind on the data format), and
 * every device behind the store's release, by name (devices[*].daemonVersion
 * and dev build against meta/settings.version). `local` is this device's own
 * daemon's status (GET /api/version), which also knows its last update's outcome.
 */
export function versionNotices(input: {
  devices: DeviceDoc[];
  settings: SettingsDoc | null;
  self: string;
  local: VersionStatus | null;
}): VersionNotice[] {
  const { devices, settings, self, local } = input;
  const out: VersionNotice[] = [];
  const storeVersion = settings?.version ?? null;
  const storeSchema = typeof settings?.schemaVersion === 'number' ? settings.schemaVersion : 0;

  // This device, from its own daemon.
  if (local) {
    const fail = failedReason(local);
    const how = local.dev
      ? `run ks-flow update (dev build: ${local.devReason ?? 'not a release'})`
      : fail
        ? `run ks-flow update (${fail})`
        : 'updating';
    if (local.readOnly) {
      out.push({
        key: 'self-schema',
        tone: 'red',
        text: `This board is read-only: ks-flow on this device (${local.version}) is behind on the data format (schema ${local.schemaVersion} < ${local.storeSchemaVersion}), so nothing here writes to the store until it updates — ${how}.`,
      });
    } else if (local.versionBehind) {
      out.push({ key: 'self', tone: 'amber', text: `ks-flow on this device is behind (${local.version} → ${local.storeVersion}): ${how}.` });
    } else if (fail) {
      out.push({ key: 'self-update', tone: 'amber', text: `ks-flow update failed on this device: ${fail}. Run ks-flow update.` });
    }
  }

  // Every other device, from the store.
  for (const d of devices) {
    if (d.forgotten || (local && d.deviceId === self)) continue;
    const behindVersion = !!storeVersion && compareSemver(storeVersion, d.daemonVersion) > 0;
    const behindSchema = typeof d.schemaVersion === 'number' && storeSchema > d.schemaVersion;
    if (!behindVersion && !behindSchema) continue;
    const who = d.deviceId === self ? 'this device' : nameOf(d, d.deviceId);
    const what = behindVersion ? `behind (${d.daemonVersion || 'unknown'} → ${storeVersion})` : `behind on the data format (schema ${d.schemaVersion} → ${storeSchema})`;
    const paused = behindSchema ? '; its store writes are paused' : '';
    const how = d.devBuild ? `dev build${d.devReason ? `: ${d.devReason}` : ''} — run ks-flow update there` : 'updating';
    out.push({ key: `dev-${d.deviceId}`, tone: 'amber', text: `ks-flow on ${who} is ${what}${paused}: ${how}.` });
  }
  return out;
}
