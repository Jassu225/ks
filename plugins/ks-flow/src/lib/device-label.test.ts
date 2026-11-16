// Tests for lib/device-label.ts: label format, the A..Z / A2.. sequence, and
// the daemon's plan for its own label (assign, keep, re-pick on a duplicate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidLabel,
  labelCandidates,
  labelFormatError,
  labelHolder,
  labelKeeper,
  nextFreeLabel,
  normalizeLabel,
  planSelfLabel,
  type LabelDevice,
} from './device-label.js';

test('isValidLabel: 1–3 chars, A–Z/0–9, a letter first', () => {
  for (const ok of ['A', 'Z', 'B2', 'AB', 'A10', 'MBP']) assert.equal(isValidLabel(ok), true, ok);
  for (const bad of ['', 'a', '2', '2A', 'ABCD', 'A-1', 'A ', ' A', 'É', null, undefined, 7]) {
    assert.equal(isValidLabel(bad), false, String(bad));
  }
});

test('normalizeLabel / labelFormatError: uppercase, trimmed; empty is allowed (auto)', () => {
  assert.equal(normalizeLabel(' b2 '), 'B2');
  assert.equal(labelFormatError(''), null);
  assert.equal(labelFormatError(' c '), null);
  assert.match(labelFormatError('ABCD')!, /at most 3/);
  assert.match(labelFormatError('1A')!, /starts with a letter/);
  assert.match(labelFormatError('A-')!, /letters A–Z and digits/);
});

test('labelCandidates: A..Z, then A2..Z2, A3…', () => {
  const all = [...labelCandidates()];
  assert.deepEqual(all.slice(0, 3), ['A', 'B', 'C']);
  assert.equal(all[25], 'Z');
  assert.deepEqual(all.slice(26, 28), ['A2', 'B2']);
  assert.equal(all[52], 'A3');
  assert.equal(all.at(-1), 'Z99');
  assert.ok(all.every(isValidLabel));
});

test('nextFreeLabel: the lowest one not taken', () => {
  assert.equal(nextFreeLabel([]), 'A');
  assert.equal(nextFreeLabel(['A', 'C']), 'B');
  const az = [...labelCandidates()].slice(0, 26);
  assert.equal(nextFreeLabel(az), 'A2');
  assert.equal(nextFreeLabel([...labelCandidates()]), null);
});

test('labelKeeper: the master device, else the smaller id', () => {
  assert.equal(labelKeeper(['dev-b', 'dev-a'], null), 'dev-a');
  assert.equal(labelKeeper(['dev-b', 'dev-a'], 'dev-b'), 'dev-b');
  assert.equal(labelKeeper(['dev-b', 'dev-a'], 'dev-z'), 'dev-a', 'a master outside the holders does not matter');
});

test('labelHolder: another live device on the label', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'a', label: 'A' },
    { deviceId: 'b', label: 'B', forgotten: true },
  ];
  assert.equal(labelHolder(devs, 'x', 'A')?.deviceId, 'a');
  assert.equal(labelHolder(devs, 'a', 'A'), null, 'not itself');
  assert.equal(labelHolder(devs, 'x', 'B'), null, 'a forgotten device holds nothing');
});

test('planSelfLabel: a device with no label takes the lowest free one', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'a', label: 'A' },
    { deviceId: 'c', label: 'C' },
    { deviceId: 'self', name: ' Mini ' },
  ];
  assert.deepEqual(planSelfLabel('self', devs, 'a'), { label: 'B', write: true, name: 'Mini', deviceCount: 3 });
});

test('planSelfLabel: the first device gets A; this device counts before its doc is read back', () => {
  assert.deepEqual(planSelfLabel('self', [], null), { label: 'A', write: true, name: null, deviceCount: 1 });
});

test('planSelfLabel: a valid unique label is kept (never overwritten), even out of sequence', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'a', label: 'A' },
    { deviceId: 'self', label: 'MBP' },
  ];
  assert.deepEqual(planSelfLabel('self', devs, 'a'), { label: 'MBP', write: false, name: null, deviceCount: 2 });
});

test('planSelfLabel: an invalid label is replaced', () => {
  const devs: LabelDevice[] = [{ deviceId: 'self', label: 'bad label' }];
  assert.equal(planSelfLabel('self', devs, null).label, 'A');
  assert.equal(planSelfLabel('self', devs, null).write, true);
});

test('planSelfLabel: forgotten devices neither count nor hold a label', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'old', label: 'A', forgotten: true },
    { deviceId: 'b', label: 'B' },
    { deviceId: 'self' },
  ];
  assert.deepEqual(planSelfLabel('self', devs, 'b'), { label: 'A', write: true, name: null, deviceCount: 2 });
});

test('planSelfLabel: on a duplicate the master device keeps it, the other re-picks', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'dev-a', label: 'A' },
    { deviceId: 'dev-b', label: 'A' },
    { deviceId: 'dev-c', label: 'B' },
  ];
  // dev-b is the master: it keeps A although its id is larger.
  assert.deepEqual(planSelfLabel('dev-b', devs, 'dev-b'), { label: 'A', write: false, name: null, deviceCount: 3 });
  assert.deepEqual(planSelfLabel('dev-a', devs, 'dev-b'), { label: 'C', write: true, name: null, deviceCount: 3 });
});

test('planSelfLabel: on a duplicate with no master among them the smaller id keeps it', () => {
  const devs: LabelDevice[] = [
    { deviceId: 'dev-a', label: 'A' },
    { deviceId: 'dev-b', label: 'A' },
    { deviceId: 'dev-m', label: 'M' },
  ];
  assert.equal(planSelfLabel('dev-a', devs, 'dev-m').write, false);
  assert.deepEqual(planSelfLabel('dev-b', devs, 'dev-m'), { label: 'B', write: true, name: null, deviceCount: 3 });
});

test('planSelfLabel: two new devices that both picked A settle in one heartbeat each', () => {
  let devs: LabelDevice[] = [
    { deviceId: 'x1', label: 'A' },
    { deviceId: 'x2', label: 'A' },
  ];
  const p1 = planSelfLabel('x1', devs, null);
  const p2 = planSelfLabel('x2', devs, null);
  assert.equal(p1.write, false);
  assert.equal(p2.label, 'B');
  devs = [devs[0], { ...devs[1], label: p2.label }];
  assert.equal(planSelfLabel('x1', devs, null).write, false);
  assert.equal(planSelfLabel('x2', devs, null).write, false);
});
