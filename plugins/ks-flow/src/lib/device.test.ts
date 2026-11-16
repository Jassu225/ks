// Tests for lib/device.ts — the device id: hashed, stored once, overridable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDeviceId,
  deviceConfigFile,
  deviceId,
  deviceIdentity,
  ensureStoredDeviceId,
  hardwareDeviceId,
  hashDeviceId,
  macosTool,
  parseIoregUuid,
  rawMachineId,
  readDeviceFile,
  readStoredDeviceId,
  resolveDeviceId,
  storeDeviceId,
  writeDeviceFile,
} from './device.js';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ksflow-device-'));
/** An env whose config folder is a fresh temp dir (never the real ~/.config/ks). */
const cfgEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ KS_CONFIG_DIR: tmp(), ...extra });

test('hashDeviceId: HMAC-SHA256 keyed "ks-flow-device", first 16 hex, stable', () => {
  const raw = '12345678-ABCD-EF01-2345-6789ABCDEF01';
  const want = createHmac('sha256', 'ks-flow-device').update(raw).digest('hex').slice(0, 16);
  assert.equal(hashDeviceId(raw), want);
  assert.match(hashDeviceId(raw), /^[0-9a-f]{16}$/);
  assert.equal(hashDeviceId(raw), hashDeviceId(raw));
  assert.equal(hashDeviceId(`${raw}\n`), want, 'surrounding whitespace does not count');
  assert.notEqual(hashDeviceId(raw), hashDeviceId('another-machine'));
  // keyed: not the plain SHA-256 of the raw id
  assert.ok(!want.includes(raw.slice(0, 8).toLowerCase()));
});

test('parseIoregUuid reads IOPlatformUUID', () => {
  const out = '+-o J316sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformSerialNumber" = "XYZ"\n      "IOPlatformUUID" = "AAAA-BBBB"\n    }\n';
  assert.equal(parseIoregUuid(out), 'AAAA-BBBB');
  assert.equal(parseIoregUuid('nothing here'), null);
});

test('macosTool: ioreg and scutil by absolute path (launchd PATH has no /usr/sbin)', () => {
  for (const t of ['ioreg', 'scutil'] as const) {
    if (existsSync(`/usr/sbin/${t}`)) assert.equal(macosTool(t), `/usr/sbin/${t}`);
    else assert.equal(macosTool(t), t);
  }
});

test('rawMachineId: found without /usr/sbin on PATH (as under launchd)', () => {
  if (process.platform !== 'darwin') return;
  const path = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    assert.ok(rawMachineId(), 'ioreg found by absolute path');
  } finally {
    process.env.PATH = path;
  }
});

test('computeDeviceId: KS_DEVICE_ID wins; else the stored id; else the hashed machine id, never the raw one', () => {
  assert.equal(computeDeviceId(cfgEnv({ KS_DEVICE_ID: 'test-b' })), 'test-b');
  const id = computeDeviceId(cfgEnv());
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(computeDeviceId(cfgEnv()), id, 'stable across calls');
  const raw = rawMachineId();
  if (raw) {
    assert.equal(id, hashDeviceId(raw));
    assert.ok(!id.includes(raw) && !raw.toLowerCase().includes(id));
  }
  const env = cfgEnv();
  storeDeviceId('stored-id', env);
  assert.equal(computeDeviceId(env), 'stored-id');
  assert.equal(computeDeviceId({ ...env, KS_DEVICE_ID: 'test-c' }), 'test-c', 'the environment beats the stored id');
});

test('storeDeviceId: writes once into ks.env, keeps the other lines and the mode, never overwrites', () => {
  const env = cfgEnv();
  const file = deviceConfigFile(env);
  writeFileSync(file, 'KS_PROJECT_ROOT_PATH=/x/y\n# note\nKS_DEVICE_ID=\n', { mode: 0o600 });
  assert.equal(readStoredDeviceId(env), null, 'an empty value is unset');
  assert.equal(storeDeviceId('abc', env), true);
  assert.equal(readFileSync(file, 'utf8'), 'KS_PROJECT_ROOT_PATH=/x/y\n# note\nKS_DEVICE_ID=abc\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(storeDeviceId('other', env), false);
  assert.equal(readStoredDeviceId(env), 'abc');

  const fresh = cfgEnv();
  writeFileSync(deviceConfigFile(fresh), 'A=1'); // no trailing newline
  storeDeviceId('x1', fresh);
  assert.equal(readFileSync(deviceConfigFile(fresh), 'utf8'), 'A=1\nKS_DEVICE_ID=x1\n');
  const quoted = cfgEnv();
  writeFileSync(deviceConfigFile(quoted), 'export KS_DEVICE_ID="q1"\n');
  assert.equal(readStoredDeviceId(quoted), 'q1');
});

test('ensureStoredDeviceId: stores a generated hardware id once; later starts read it back', () => {
  const env = cfgEnv();
  const first = ensureStoredDeviceId(env);
  if (first.source === 'hostname') {
    assert.equal(first.stored, false, 'a host-name id is never stored');
    assert.equal(readStoredDeviceId(env), null);
    return;
  }
  assert.deepEqual([first.source, first.stored], ['hardware', true]);
  assert.equal(readStoredDeviceId(env), first.deviceId);
  const again = ensureStoredDeviceId(env);
  assert.deepEqual([again.source, again.stored, again.deviceId], ['config', false, first.deviceId]);

  // An override is used, not stored.
  const env2 = cfgEnv({ KS_DEVICE_ID: 'test-b' });
  assert.deepEqual([ensureStoredDeviceId(env2).source, readStoredDeviceId(env2)], ['env', null]);
});

test('resolveDeviceId: a copied config keeps its id and reports this machine\'s own', () => {
  const env = cfgEnv();
  storeDeviceId('from-another-mac', env);
  const r = resolveDeviceId(env);
  assert.equal(r.deviceId, 'from-another-mac');
  assert.equal(r.source, 'config');
  assert.equal(r.hardwareId, hardwareDeviceId());
});

test('device.json: written, read back; the board/CLI view prefers KS_DEVICE_ID, the stored id, then the file', () => {
  const dir = tmp();
  const env = cfgEnv();
  assert.equal(readDeviceFile(dir), null);
  writeDeviceFile(dir, { deviceId: 'abc123', defaultName: 'Laptop A' });
  assert.deepEqual(readDeviceFile(dir), { deviceId: 'abc123', defaultName: 'Laptop A', label: null, name: null, deviceCount: 1 });
  assert.equal(deviceId(dir, env), 'abc123');
  assert.deepEqual(deviceIdentity(dir, { ...env, KS_DEVICE_ID: 'abc123' }), { deviceId: 'abc123', defaultName: 'Laptop A' });
  assert.equal(deviceId(dir, { ...env, KS_DEVICE_ID: 'test-c' }), 'test-c');
  storeDeviceId('abc123', env);
  assert.deepEqual(deviceIdentity(dir, env), { deviceId: 'abc123', defaultName: 'Laptop A' }, 'stored id, name from the file');
  const env2 = cfgEnv();
  storeDeviceId('zzz', env2);
  assert.equal(deviceId(dir, env2), 'zzz', 'the stored id beats a stale device.json');
  writeFileSync(join(dir, 'device.json'), '{not json');
  assert.equal(readDeviceFile(dir), null);
  const env3 = cfgEnv();
  assert.equal(deviceId(dir, env3), computeDeviceId(env3), 'nothing stored, no usable file: generated');
});

test('device.json: label, name and deviceCount written and read back; an older file reads with defaults', () => {
  const dir = tmp();
  writeDeviceFile(dir, { deviceId: 'abc', defaultName: 'Laptop', label: 'B', name: 'Work', deviceCount: 3 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'device.json'), 'utf8')), {
    deviceId: 'abc',
    defaultName: 'Laptop',
    label: 'B',
    name: 'Work',
    deviceCount: 3,
  });
  assert.deepEqual(readDeviceFile(dir), { deviceId: 'abc', defaultName: 'Laptop', label: 'B', name: 'Work', deviceCount: 3 });
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ deviceId: 'abc', defaultName: 'Laptop' }));
  assert.deepEqual(readDeviceFile(dir), { deviceId: 'abc', defaultName: 'Laptop', label: null, name: null, deviceCount: 1 });
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ deviceId: 'abc', label: 7, name: '', deviceCount: -1 }));
  assert.deepEqual(readDeviceFile(dir), { deviceId: 'abc', defaultName: 'abc', label: null, name: null, deviceCount: 1 });
  // The board/CLI identity stays {deviceId, defaultName}.
  assert.deepEqual(deviceIdentity(dir, { ...cfgEnv(), KS_DEVICE_ID: '' }), { deviceId: 'abc', defaultName: 'abc' });
});
