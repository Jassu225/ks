// Tests for lib/device-list.ts (`ks-flow devices`): rows, order, the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceDoc } from './db/types.js';
import {
  formatDevices,
  listDevices,
  liveSessionNames,
  readDevicesCache,
  refreshRows,
  sameNames,
  writeDevicesCache,
} from './device-list.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
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
    liveSessionNames: [],
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

test('liveSessionNames: trimmed, non-empty, deduped, sorted', () => {
  assert.deepEqual(
    liveSessionNames([{ name: ' B:KAR-2 ' }, { name: null }, { name: '' }, { name: 'B:KAR-1' }, { name: 'B:KAR-2' }, {}]),
    ['B:KAR-1', 'B:KAR-2'],
  );
  assert.deepEqual(liveSessionNames([]), []);
  assert.equal(sameNames(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameNames(['b', 'a'], ['a', 'b']), false);
  assert.equal(sameNames(undefined, []), false, 'never published: write it once');
  assert.equal(sameNames([], []), true);
});

test('listDevices: carries each device\'s session names (cleaned); none = []', () => {
  const rows = listDevices(
    [dev({ deviceId: 'a', liveSessionNames: ['A:KAR-9', ' ', 'A:KAR-1', 'A:KAR-9'] }), dev({ deviceId: 'b' })],
    'a',
    null,
    NOW,
  );
  assert.deepEqual(rows[0].liveSessionNames, ['A:KAR-1', 'A:KAR-9']);
  assert.deepEqual(rows[1].liveSessionNames, []);
});

test('devices.json: written, read back; self and stale recomputed against now; bad files read as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksf-devcache-'));
  assert.equal(readDevicesCache(dir), null);
  const rows = listDevices(
    [dev({ deviceId: 'me', label: 'A', liveSessionNames: ['A:KAR-1'] }), dev({ deviceId: 'peer', label: 'B' })],
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
    JSON.stringify({ updatedAt: ago(0), self: 'me', devices: [{ deviceId: 'x', liveSessionNames: ['n', 3] }, { label: 'Z' }] }),
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
      liveSessionNames: ['n'],
    },
  ]);
});

test('formatDevices: session names under their device; "as of" from the cache', () => {
  const rows = listDevices([dev({ deviceId: 'me', label: 'A', liveSessionNames: ['A:KAR-1', 'A:KAR-2'] })], 'me', null, NOW);
  const lines = formatDevices(rows, NOW, ago(3 * 60_000)).split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[2], /^\s+sessions: A:KAR-1, A:KAR-2$/);
  assert.equal(lines[2].indexOf('sessions'), lines[0].indexOf('NAME'));
  assert.match(lines[3], /^as of 3m ago/);
  assert.doesNotMatch(formatDevices(rows, NOW), /as of/);
  assert.match(formatDevices([], NOW, ago(0)), /No device[\s\S]*as of just now/);
});

