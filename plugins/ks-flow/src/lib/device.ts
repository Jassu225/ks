// lib/device.ts — this device's id and default name (one ks-flow board for
// several devices). web/lib/device.ts is its twin: keep the two in step.
//
// The id is generated once per machine and then stored: ks-config's
// `ks.KS_DEVICE_ID`, in ${KS_CONFIG_DIR:-~/.config/ks}/ks.env (one file for the
// whole machine, every project's data dir). Lookup:
//   1. KS_DEVICE_ID in the real environment (tests, several daemons on one Mac);
//   2. the stored ks.KS_DEVICE_ID;
//   3. generated: HMAC-SHA256(key "ks-flow-device", the machine's raw id), first
//      16 hex characters. The raw id never leaves this module: it is not
//      logged, stored or returned.
//        macOS: IOPlatformUUID (`/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`),
//               which belongs to the logic board (same id across OS reinstalls).
//        Linux: /etc/machine-id, then /var/lib/dbus/machine-id.
//        Neither: a hash of the host name (the caller warns; never stored).
// The daemon stores a generated hardware id on its first start
// (ensureStoredDeviceId) and writes <dataDir>/device.json, which the board
// and the CLIs use for the name:
//   { deviceId, defaultName,
//     label: this device's label on the shared board (lib/device-label.ts) | null,
//     name: the user's name for it (Settings → Devices) | null,
//     deviceCount: devices on the board, forgotten ones left out }
// rewritten by the heartbeat whenever label, name or deviceCount change. A
// file from before them reads as label null, name null, deviceCount 1.
//
// A stored id that differs from this machine's hardware id means the config
// was copied from another Mac (Migration Assistant, synced dotfiles) or the
// logic board was replaced: the stored id is kept, and the daemon and
// `ks-setup doctor` warn (two Macs with one id would fight over the cards).
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const DEVICE_HMAC_KEY = 'ks-flow-device';
export const DEVICE_FILE = 'device.json';
/** The ks-config key (namespace `ks`) and env variable holding the id. */
export const DEVICE_ID_KEY = 'KS_DEVICE_ID';

export interface DeviceIdentity {
  deviceId: string;
  defaultName: string;
}

/** <dataDir>/device.json: the identity plus what the daemon last read from the store. */
export interface DeviceFile extends DeviceIdentity {
  label: string | null;
  name: string | null;
  deviceCount: number;
}

/** Where the id came from: env override, the stored config, generated from the hardware, or the host name. */
export type DeviceIdSource = 'env' | 'config' | 'hardware' | 'hostname';

export interface DeviceIdResolution {
  deviceId: string;
  source: DeviceIdSource;
  /** This machine's hashed hardware id (null when it has none); differs from deviceId after a copied config. */
  hardwareId: string | null;
}

/**
 * ioreg and scutil live in /usr/sbin, which launchd's PATH for the daemon
 * (node's folder, /usr/local/bin, /usr/bin, /bin) leaves out: called by bare
 * name, the daemon found neither and fell back to the host-name id, a
 * different id from the one every shell computes. Called by absolute path; the
 * bare name only when that file is missing.
 */
export function macosTool(name: 'ioreg' | 'scutil'): string {
  const abs = `/usr/sbin/${name}`;
  return existsSync(abs) ? abs : name;
}

/** The stored id for a raw machine id: keyed with the app's name, so no other app's hash matches it. */
export function hashDeviceId(raw: string): string {
  return createHmac('sha256', DEVICE_HMAC_KEY).update(raw.trim()).digest('hex').slice(0, 16);
}

/** IOPlatformUUID out of `ioreg -rd1 -c IOPlatformExpertDevice` output. */
export function parseIoregUuid(out: string): string | null {
  const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
  return m ? m[1] : null;
}

function readTrim(path: string): string | null {
  try {
    const v = readFileSync(path, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** The machine's raw id, or null when the platform gives none. Never log it. */
export function rawMachineId(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') {
    try {
      const out = execFileSync(macosTool('ioreg'), ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      });
      return parseIoregUuid(out);
    } catch {
      return null;
    }
  }
  return readTrim('/etc/machine-id') ?? readTrim('/var/lib/dbus/machine-id');
}

/** `scutil --get ComputerName` on macOS, else the host name. */
export function defaultDeviceName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    try {
      const n = execFileSync(macosTool('scutil'), ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      if (n) return n;
    } catch {
      /* fall through */
    }
  }
  return hostname();
}

/** ${KS_CONFIG_DIR:-~/.config/ks}/ks.env */
export function deviceConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.KS_CONFIG_DIR || join(homedir(), '.config', 'ks'), 'ks.env');
}

const KEY_LINE = new RegExp(`^\\s*(?:export\\s+)?${DEVICE_ID_KEY}\\s*=\\s*(.*?)\\s*$`);

/** The stored ks.KS_DEVICE_ID, or null. */
export function readStoredDeviceId(env: NodeJS.ProcessEnv = process.env): string | null {
  let raw: string;
  try {
    raw = readFileSync(deviceConfigFile(env), 'utf8');
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const line of raw.split('\n')) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    found = v.trim() || null; // the last line wins, as in a shell
  }
  return found;
}

/**
 * Store `id` as ks.KS_DEVICE_ID, only when none is stored yet (never
 * overwrites). The rest of ks.env is kept as is. Returns whether it wrote.
 */
export function storeDeviceId(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (readStoredDeviceId(env)) return false;
  const file = deviceConfigFile(env);
  let raw = '';
  let mode: number | undefined;
  try {
    raw = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  // A key line with an empty value counts as unset: drop it before appending.
  const kept = raw
    .split('\n')
    .filter((l) => !KEY_LINE.test(l))
    .join('\n');
  const body = `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${DEVICE_ID_KEY}=${id}\n`;
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
  return true;
}

/** This machine's hashed hardware id, or null when it has none. */
export function hardwareDeviceId(): string | null {
  const raw = rawMachineId();
  return raw ? hashDeviceId(raw) : null;
}

/** Where this device's id comes from right now (nothing is written). */
export function resolveDeviceId(env: NodeJS.ProcessEnv = process.env): DeviceIdResolution {
  const hardwareId = hardwareDeviceId();
  const override = env[DEVICE_ID_KEY]?.trim();
  if (override) return { deviceId: override, source: 'env', hardwareId };
  const stored = readStoredDeviceId(env);
  if (stored) return { deviceId: stored, source: 'config', hardwareId };
  if (hardwareId) return { deviceId: hardwareId, source: 'hardware', hardwareId };
  return { deviceId: hashDeviceId(`host:${hostname()}`), source: 'hostname', hardwareId: null };
}

/**
 * The daemon's start: resolve the id and store a generated hardware id, so
 * every later start (and every CLI, the board, the backfill) reads it back
 * instead of generating it again. A host-name id is never stored: it changes
 * with the host name. Returns the resolution and whether it stored the id.
 */
export function ensureStoredDeviceId(env: NodeJS.ProcessEnv = process.env): DeviceIdResolution & { stored: boolean } {
  const r = resolveDeviceId(env);
  if (r.source !== 'hardware') return { ...r, stored: false };
  return { ...r, stored: storeDeviceId(r.deviceId, env) };
}

/** True when the id came from the host name (no machine id): the caller warns. */
export let deviceIdFromHostname = false;

/** The id, now: KS_DEVICE_ID, else the stored one, else the hashed machine id, else a hashed host name. */
export function computeDeviceId(env: NodeJS.ProcessEnv = process.env): string {
  const r = resolveDeviceId(env);
  deviceIdFromHostname = r.source === 'hostname';
  return r.deviceId;
}

/** <dataDir>/device.json, or null when missing or malformed (fields added later get their defaults). */
export function readDeviceFile(dataDir: string): DeviceFile | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, DEVICE_FILE), 'utf8')) as Partial<DeviceFile>;
    if (typeof j.deviceId !== 'string' || !j.deviceId) return null;
    return {
      deviceId: j.deviceId,
      defaultName: typeof j.defaultName === 'string' ? j.defaultName : j.deviceId,
      label: typeof j.label === 'string' && j.label ? j.label : null,
      name: typeof j.name === 'string' && j.name ? j.name : null,
      deviceCount: typeof j.deviceCount === 'number' && j.deviceCount >= 0 ? j.deviceCount : 1,
    };
  } catch {
    return null;
  }
}

/** Write <dataDir>/device.json (write-then-rename); a field left out gets its default. */
export function writeDeviceFile(dataDir: string, f: DeviceIdentity & Partial<DeviceFile>): void {
  const doc: DeviceFile = {
    deviceId: f.deviceId,
    defaultName: f.defaultName,
    label: f.label ?? null,
    name: f.name ?? null,
    deviceCount: f.deviceCount ?? 1,
  };
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DEVICE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

/** The daemon's view: resolved now (KS_DEVICE_ID, the stored id, generated), never read from device.json. */
export function computeDeviceIdentity(env: NodeJS.ProcessEnv = process.env): DeviceIdentity {
  return { deviceId: computeDeviceId(env), defaultName: defaultDeviceName() };
}

/**
 * The board's and the CLIs' view: KS_DEVICE_ID, else the stored id, else
 * device.json (the daemon's), else generated. The name comes from device.json
 * when it names the same id.
 */
export function deviceIdentity(dataDir: string, env: NodeJS.ProcessEnv = process.env): DeviceIdentity {
  const file = readDeviceFile(dataDir);
  const id = env[DEVICE_ID_KEY]?.trim() || readStoredDeviceId(env);
  if (id) return { deviceId: id, defaultName: file?.deviceId === id ? file.defaultName : defaultDeviceName() };
  if (file) return { deviceId: file.deviceId, defaultName: file.defaultName };
  return computeDeviceIdentity(env);
}

/** Shorthand: this device's id as the board and the CLIs see it. */
export function deviceId(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return deviceIdentity(dataDir, env).deviceId;
}
