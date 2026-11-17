import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LiveMirror, backoffMs, type LiveStatus } from './live-mirror.js';
import { openErrors, readErrors, recordError, resolveError } from './errors-log.js';

/** A fake listener: the test pushes data and errors through it. */
function fakeSource<T>() {
  const s = {
    attaches: 0,
    stops: 0,
    data: null as ((v: T) => void) | null,
    error: null as ((e: Error) => void) | null,
    failOnAttach: false,
    spec: (name: string) => ({
      name,
      label: name,
      attach: (onData: (v: T) => void, onError: (e: Error) => void) => {
        s.attaches++;
        if (s.failOnAttach) throw new Error('refused');
        s.data = onData;
        s.error = onError;
        return () => {
          s.stops++;
        };
      },
    }),
  };
  return s;
}

test('backoff: 15 s doubling, at most 15 min', () => {
  assert.equal(backoffMs(1), 15_000);
  assert.equal(backoffMs(2), 30_000);
  assert.equal(backoffMs(3), 60_000);
  assert.equal(backoffMs(20), 15 * 60_000);
});

test('ensure attaches once; a healthy listener is never re-attached', () => {
  let now = 0;
  const m = new LiveMirror({ now: () => now });
  const src = fakeSource<number[]>();
  const h = m.add(src.spec('reminders'));
  assert.equal(h.get(), undefined);
  m.ensure();
  assert.equal(src.attaches, 1);
  src.data!([1, 2]);
  assert.deepEqual(h.get(), [1, 2]);
  assert.equal(h.live(), true);
  for (let i = 0; i < 10; i++) {
    now += 15_000;
    m.ensure();
  }
  assert.equal(src.attaches, 1);
});

test('a failed listener keeps its data, reports once, re-attaches after the backoff and recovers', () => {
  let now = 0;
  const failed: LiveStatus[] = [];
  const recovered: LiveStatus[] = [];
  const m = new LiveMirror({ now: () => now, onFail: (s) => failed.push(s), onRecover: (s) => recovered.push(s) });
  const src = fakeSource<string>();
  const h = m.add(src.spec('settings'));
  m.ensure();
  src.data!('a');
  src.error!(new Error('Exceeded maximum number of retries allowed.'));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].retryAt, 15_000);
  assert.equal(h.get(), 'a');
  assert.equal(h.live(), false);
  assert.equal(src.stops, 1);
  now = 10_000;
  m.ensure();
  assert.equal(src.attaches, 1, 'not before the backoff');
  now = 15_000;
  m.ensure();
  assert.equal(src.attaches, 2);
  src.data!('b');
  assert.equal(h.get(), 'b');
  assert.equal(recovered.length, 1);
  assert.equal(m.status()[0].failures, 0);
});

test('callbacks from a stopped listener are ignored', () => {
  let now = 0;
  const m = new LiveMirror({ now: () => now });
  const src = fakeSource<string>();
  const h = m.add(src.spec('x'));
  m.ensure();
  const oldData = src.data!;
  const oldError = src.error!;
  oldError(new Error('boom'));
  now = 15_000;
  m.ensure();
  oldData('stale');
  oldError(new Error('late'));
  assert.equal(h.get(), undefined);
  assert.equal(m.status()[0].state, 'connecting');
  assert.equal(m.status()[0].failures, 1);
});

test('a listener that throws on attach counts as failed and backs off further each time', () => {
  let now = 0;
  const m = new LiveMirror({ now: () => now });
  const src = fakeSource<string>();
  src.failOnAttach = true;
  m.add(src.spec('x'));
  m.ensure();
  assert.equal(m.status()[0].state, 'failed');
  now = 15_000;
  m.ensure();
  assert.equal(m.status()[0].failures, 2);
  assert.equal(m.status()[0].retryAt, 15_000 + 30_000);
});

test('want(false) stops it and clears its failure; want(true) attaches at once', () => {
  const recovered: string[] = [];
  const m = new LiveMirror({ now: () => 0, onRecover: (s) => recovered.push(s.name) });
  const src = fakeSource<string>();
  m.add(src.spec('masterRequests'), false);
  m.ensure();
  assert.equal(src.attaches, 0);
  m.want('masterRequests', true);
  assert.equal(src.attaches, 1);
  src.error!(new Error('boom'));
  m.want('masterRequests', false);
  assert.deepEqual(recovered, ['masterRequests']);
  assert.equal(m.status()[0].state, 'off');
});

test('errors log: opens once, counts, resolves, reopens as a new problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksf-errors-'));
  const t0 = new Date('2026-11-17T10:00:00Z');
  assert.equal(recordError(dir, { key: 'listener:reminders', title: 'Reminders', message: 'a' }, t0).opened, true);
  const second = recordError(dir, { key: 'listener:reminders', title: 'Reminders', message: 'b' }, new Date('2026-11-17T10:01:00Z'));
  assert.equal(second.opened, false);
  assert.equal(second.entry.count, 2);
  assert.equal(openErrors(dir).length, 1);
  assert.ok(resolveError(dir, 'listener:reminders', new Date('2026-11-17T10:02:00Z')));
  assert.equal(resolveError(dir, 'listener:reminders'), null);
  assert.equal(openErrors(dir).length, 0);
  assert.equal(recordError(dir, { key: 'listener:reminders', title: 'Reminders', message: 'c' }, new Date('2026-11-17T11:00:00Z')).opened, true);
  assert.equal(readErrors(dir).entries.length, 2);
});

test('errors log: resolved entries older than 7 days are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ksf-errors-'));
  recordError(dir, { key: 'job:a', title: 'A', message: 'x' }, new Date('2026-11-01T00:00:00Z'));
  resolveError(dir, 'job:a', new Date('2026-11-01T00:01:00Z'));
  recordError(dir, { key: 'job:b', title: 'B', message: 'y' }, new Date('2026-11-17T00:00:00Z'));
  assert.deepEqual(readErrors(dir).entries.map((e) => e.key), ['job:b']);
});
