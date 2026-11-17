// Tests for lib/device-list.ts (`ks-flow devices`): rows, order, the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceDoc, PeerSession } from './db/types.js';
import { cleanSessions, formatDevices, listDevices, readDevicesCache, refreshRows, writeDevicesCache } from './device-list.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sess = (p: Partial<PeerSession> & { sessionId: string }): PeerSession => ({
  name: null,
  bridgeSessionId: null,
  pid: 1,
  unitId: null,
  title: null,
  folder: 'f',
  tmuxPane: null,
  startedAt: ago(60_000),
  status: null,
  statusAt: null,
  waiting: null,
  ...p,
});
const dev = (p: Partial<DeviceDoc> & { deviceId: string }): DeviceDoc => ({
  defaultName: `Mac ${p.deviceId}`,
  platform: 'darwin',
  daemonVersion: '0.4.0',
  lastSeenAt: ago(30_000),
  projectPath: '/p',
  commonDir: '/p/.git',
  worktreePaths: [],
  inboxUrl: null,
  inboxRunning: false,
  linearCheckedAt: null,
  ...p,
});

test('listDevices: this device first, then by label (none last), with every flag', () => {
  const rows = listDevices(
    [
      dev({ deviceId: 'd3', label: null, lastSeenAt: ago(10 * 60_000) }),
      dev({ deviceId: 'd2', label: 'B', name: 'Mini' }),
      dev({ deviceId: 'd1', label: 'A10' }),
      dev({ deviceId: 'd4', label: 'A2', forgotten: true }),
      dev({ deviceId: 'me', label: 'C' }),
      dev({ deviceId: 'd5', label: 'A' }),
    ],
    'me',
    'd2',
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.deviceId),
    ['me', 'd5', 'd4', 'd1', 'd2', 'd3'],
  );
  assert.deepEqual(rows[0], {
    label: 'C',
    name: 'Mac me',
    deviceId: 'me',
    lastSeenAt: ago(30_000),
    self: true,
    master: false,
    forgotten: false,
    stale: false,
    sessions: [],
  });
  const byId = new Map(rows.map((r) => [r.deviceId, r]));
  assert.equal(byId.get('d2')!.name, 'Mini', 'the user name over the default name');
  assert.equal(byId.get('d2')!.master, true);
  assert.equal(byId.get('d3')!.stale, true);
  assert.equal(byId.get('d3')!.label, null);
  assert.equal(byId.get('d4')!.forgotten, true);
});

test('listDevices: never seen counts as stale', () => {
  const [r] = listDevices([dev({ deviceId: 'x', lastSeenAt: '' })], 'y', null, NOW);
  assert.equal(r.stale, true);
  assert.equal(r.lastSeenAt, null);
  assert.equal(r.master, false);
});

test('formatDevices: an aligned table, this device marked', () => {
  const rows = listDevices(
    [dev({ deviceId: 'aaaa', label: 'A' }), dev({ deviceId: 'bb', label: 'B', name: 'Long name here', lastSeenAt: ago(3 * 3600_000) })],
    'bb',
    'aaaa',
    NOW,
  );
  const lines = formatDevices(rows, NOW).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\s+LABEL\s+NAME\s+DEVICE\s+LAST SEEN$/);
  assert.match(lines[1], /^\*\s+B\s+Long name here\s+bb\s+3h ago\s+this device, stale$/);
  assert.match(lines[2], /^\s+A\s+Mac aaaa\s+aaaa\s+just now\s+master$/);
  const col = lines[0].indexOf('DEVICE');
  assert.equal(lines[1].indexOf('bb'), col);
  assert.equal(lines[2].indexOf('aaaa', lines[2].indexOf('Mac aaaa') + 8), col);
  assert.match(formatDevices([], NOW), /No device/);
});

test('cleanSessions: entries without a session id dropped; not an array = []', () => {
  const a = sess({ sessionId: 's1', name: 'A:KAR-1' });
  assert.deepEqual(cleanSessions([a, null, 3, { name: 'x' }]), [a]);
  assert.deepEqual(cleanSessions(undefined), []);
  assert.deepEqual(cleanSessions('nope'), []);
});

test("listDevices: carries each device's published sessions; none = []", () => {
  const a = sess({ sessionId: 's1' });
  const rows = listDevices([dev({ deviceId: 'a', sessions: [a] }), dev({ deviceId: 'b' })], 'a', null, NOW);
  assert.deepEqual(rows[0].sessions, [a]);
  assert.deepEqual(rows[1].sessions, []);
});

test('devices.json: written, read back; self and stale recomputed against now; bad files read as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksf-devcache-'));
  assert.equal(readDevicesCache(dir), null);
  const rows = listDevices(
    [dev({ deviceId: 'me', label: 'A', sessions: [sess({ sessionId: 's1' })] }), dev({ deviceId: 'peer', label: 'B' })],
    'me',
    'peer',
    NOW,
  );
  writeDevicesCache(dir, { updatedAt: ago(0), self: 'me', devices: rows });
  const back = readDevicesCache(dir)!;
  assert.deepEqual(back, { updatedAt: ago(0), self: 'me', devices: rows });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8'))), ['updatedAt', 'self', 'devices']);
  // Ten minutes later, read by the peer's id (KS_DEVICE_ID override): every device stale, peer first.
  const later = refreshRows(back.devices, 'peer', NOW + 10 * 60_000);
  assert.deepEqual(
    later.map((r) => [r.deviceId, r.self, r.stale]),
    [
      ['peer', true, true],
      ['me', false, true],
    ],
  );
  writeFileSync(join(dir, 'devices.json'), '{"devices": []}');
  assert.equal(readDevicesCache(dir), null, 'no updatedAt');
  writeFileSync(join(dir, 'devices.json'), '{nope');
  assert.equal(readDevicesCache(dir), null);
  writeFileSync(
    join(dir, 'devices.json'),
    JSON.stringify({ updatedAt: ago(0), self: 'me', devices: [{ deviceId: 'x', sessions: [{ sessionId: 'n' }, 3] }, { label: 'Z' }] }),
  );
  assert.deepEqual(readDevicesCache(dir)!.devices, [
    {
      label: null,
      name: 'x',
      deviceId: 'x',
      lastSeenAt: null,
      self: false,
      master: false,
      forgotten: false,
      stale: false,
      sessions: [{ sessionId: 'n' }],
    },
  ]);
});

test('formatDevices: devices only (sessions: ks-flow peers); "as of" from the cache', () => {
  const rows = listDevices([dev({ deviceId: 'me', label: 'A', sessions: [sess({ sessionId: 's1' })] })], 'me', null, NOW);
  const lines = formatDevices(rows, NOW, ago(3 * 60_000)).split('\n');
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join('\n'), /sessions:/);
  assert.match(lines[2], /^as of 3m ago/);
  assert.doesNotMatch(formatDevices(rows, NOW), /as of/);
  assert.match(formatDevices([], NOW, ago(0)), /No device[\s\S]*as of just now/);
});
