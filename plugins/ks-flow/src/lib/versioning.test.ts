// Tests for versioning (lib/versioning.ts, lib/build-info.ts, lib/update.ts):
// semver order, the upward-only raise (never from a dev build) against the
// in-memory DocDb, the write gate while behind on the data format, the
// daemon's decisions, and the clone update's preconditions with a fake git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import { Outbox, type DocStore, type StoreOp } from './db/outbox.js';
import type { SettingsDoc } from './db/types.js';
import { cloneState, detectBuild, devReason, installMode, type Git } from './build-info.js';
import { marketplaceOf, newestCachedRoot, planUpdate, runUpdate, type Step } from './update.js';
import {
  behindMessage,
  compareSemver,
  currentRelease,
  decideRelease,
  decideVersion,
  mayAutoUpdate,
  readReleaseCheck,
  RELEASE_BUSY_RETRY_MS,
  RELEASE_CHECK_MS,
  releaseCheckFrom,
  UPDATE_BUSY_RETRY_MS,
  writeReleaseCheck,
  type ReleaseCheck,
  raisePatch,
  readVersionStatus,
  SCHEMA_VERSION,
  standing,
  startupStatus,
  storeWriteBlock,
  UPDATE_RETRY_MS,
  writeVersionStatus,
  type CodeVersion,
  type UpdateState,
  type VersionStatus,
} from './versioning.js';

const tmp = (): string => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-flow-version-'));
const AT = '2026-11-16T12:00:00.000Z';
const release = (version: string, schemaVersion = 1): CodeVersion => ({ version, schemaVersion, dev: false, devReason: null });

function status(over: Partial<VersionStatus> = {}): VersionStatus {
  return {
    deviceId: 'dev-a',
    deviceName: 'Mac A',
    version: '1.4.2',
    schemaVersion: 1,
    dev: false,
    devReason: null,
    mode: 'marketplace',
    storeVersion: null,
    storeSchemaVersion: 0,
    versionBehind: false,
    schemaBehind: false,
    readOnly: false,
    update: null,
    release: null,
    notified: null,
    updatedAt: AT,
    ...over,
  };
}

// ── semver ──────────────────────────────────────────────────────────────────

test('compareSemver: numeric parts, not strings', () => {
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('1.4.2', '1.5.0'), -1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
});

test('compareSemver: a pre-release sorts before its release; build metadata is ignored', () => {
  assert.equal(compareSemver('1.5.0-rc.1', '1.5.0'), -1);
  assert.equal(compareSemver('1.5.0-rc.2', '1.5.0-rc.10'), -1);
  assert.equal(compareSemver('1.5.0-alpha', '1.5.0-1'), 1);
  assert.equal(compareSemver('1.5.0+abc', '1.5.0'), 0);
});

test('compareSemver: anything that is not semver sorts first', () => {
  assert.equal(compareSemver('unknown', '0.0.1'), -1);
  assert.equal(compareSemver('0.0.1', null), 1);
  assert.equal(compareSemver(undefined, 'x'), 0);
});

// ── raise ───────────────────────────────────────────────────────────────────

test('raisePatch: only upward, stamped with who and when', () => {
  assert.deepEqual(raisePatch({ version: '1.4.2', schemaVersion: 1 }, release('1.5.0'), 'dev-a', AT), {
    version: '1.5.0',
    versionBy: 'dev-a',
    versionAt: AT,
  });
  assert.equal(raisePatch({ version: '1.5.0', schemaVersion: 1 }, release('1.4.2'), 'dev-a', AT), null);
  assert.equal(raisePatch({ version: '1.5.0', schemaVersion: 1 }, release('1.5.0'), 'dev-a', AT), null);
  assert.deepEqual(raisePatch({ version: '1.5.0', schemaVersion: 1 }, release('1.5.0', 2), 'dev-a', AT), {
    schemaVersion: 2,
    versionBy: 'dev-a',
    versionAt: AT,
  });
  // An older schema never lowers the store's.
  assert.equal(raisePatch({ version: '1.5.0', schemaVersion: 3 }, release('1.5.0', 2), 'dev-a', AT), null);
});

test('raisePatch: a dev build never raises; nor does anything before meta/settings exists', () => {
  assert.equal(raisePatch({ version: '1.0.0' }, { ...release('9.9.9', 9), dev: true, devReason: 'uncommitted changes' }, 'dev-a', AT), null);
  assert.equal(raisePatch(null, release('9.9.9'), 'dev-a', AT), null);
});

test('raiseVersion (in-memory store): raises meta/settings in place, upward only, never creates it', async () => {
  const db = new MemoryDocDb({ 'meta/settings': { masterDeviceId: 'dev-a', version: '1.4.2', schemaVersion: 1 } });
  const store = docDeviceStore(db);
  const code = release('1.5.0', SCHEMA_VERSION);
  const out = await store.raiseVersion!((cur) => raisePatch(cur, code, 'dev-b', AT));
  assert.equal(out?.version, '1.5.0');
  const s = (await store.getSettings()) as SettingsDoc;
  assert.equal(s.version, '1.5.0');
  assert.equal(s.versionBy, 'dev-b');
  assert.equal(s.masterDeviceId, 'dev-a', 'other fields are kept');
  // An older device can't take it back down.
  assert.equal(await store.raiseVersion!((cur) => raisePatch(cur, release('1.4.9'), 'dev-c', AT)), null);
  assert.equal(((await store.getSettings()) as SettingsDoc).version, '1.5.0');
  // No meta/settings (before the backfill): nothing is created.
  const empty = docDeviceStore(new MemoryDocDb());
  assert.equal(await empty.raiseVersion!((cur) => raisePatch(cur, code, 'dev-b', AT)), null);
  assert.equal(await empty.getSettings(), null);
});

// ── standing and the status file ────────────────────────────────────────────

test('standing: behind on version, on the data format, or neither', () => {
  assert.deepEqual(standing({ version: '1.5.0', schemaVersion: 1 }, release('1.4.2')), {
    storeVersion: '1.5.0',
    storeSchemaVersion: 1,
    versionBehind: true,
    schemaBehind: false,
  });
  assert.equal(standing({ version: '1.5.0', schemaVersion: 2 }, release('1.5.0')).schemaBehind, true);
  assert.equal(standing({ version: '1.4.0', schemaVersion: 1 }, release('1.5.0')).versionBehind, false);
  assert.equal(standing(null, release('1.5.0')).versionBehind, false);
});

test('behind on the data format → the read-only flag, and the gate drops every write (none queued)', async () => {
  const dir = tmp();
  assert.equal(storeWriteBlock(dir), null, 'no status file: writes allowed');
  const d = decideVersion({
    prev: status(),
    settings: { version: '1.5.0', schemaVersion: 2 },
    code: release('1.4.2', 1),
    mode: 'marketplace',
    update: null,
    now: Date.parse(AT),
    alive: () => false,
  });
  assert.equal(d.status.readOnly, true);
  assert.equal(d.status.schemaBehind, true);
  writeVersionStatus(dir, d.status);
  assert.match(storeWriteBlock(dir) ?? '', /behind on the data format \(schema 1 < 2\)/);

  const applied: StoreOp[][] = [];
  const store: DocStore = {
    async apply(ops) {
      applied.push(ops);
    },
  };
  const ob = new Outbox(join(dir, 'outbox'), store, { log: () => {}, blocked: () => storeWriteBlock(dir) });
  await ob.write([{ op: 'set', path: 'workUnits/KAR-1', data: { a: 1 } }]);
  assert.equal(applied.length, 0, 'nothing reaches the store');
  assert.equal(ob.pending(), 0, 'nothing is queued for later either');
  assert.equal(ob.dropped, 1);

  // Caught up: the next status lifts the gate and writes go through again.
  writeVersionStatus(dir, { ...d.status, schemaBehind: false, readOnly: false });
  assert.equal(storeWriteBlock(dir), null);
  await ob.write([{ op: 'set', path: 'workUnits/KAR-1', data: { a: 2 } }]);
  assert.equal(applied.length, 1);
});

test('the gate holds what was queued before (no flush while behind)', async () => {
  const dir = tmp();
  let blocked: string | null = null;
  const applied: StoreOp[][] = [];
  const offline = { on: true };
  const store: DocStore = {
    async apply(ops) {
      if (offline.on) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      applied.push(ops);
    },
  };
  const ob = new Outbox(join(dir, 'outbox'), store, { log: () => {}, settleMs: 0, blocked: () => blocked });
  await ob.write([{ op: 'set', path: 'reminders/r1', data: { a: 1 } }]);
  assert.equal(ob.pending(), 1);
  offline.on = false;
  blocked = 'behind';
  const r = await ob.flush();
  assert.equal(r.applied, 0);
  assert.equal(ob.pending(), 1, 'kept for the updated daemon');
  blocked = null;
  assert.equal((await ob.flush()).applied, 1);
});

test('startupStatus: read-only carries over only while the code is the same', () => {
  const prev = status({ storeVersion: '1.5.0', storeSchemaVersion: 2, schemaBehind: true, readOnly: true, versionBehind: true });
  const base = { deviceId: 'dev-a', deviceName: 'Mac A', version: '1.4.2', schemaVersion: 1, dev: false, devReason: null, mode: 'marketplace' as const, update: null };
  assert.equal(startupStatus(prev, base, AT).readOnly, true, 'same code: still behind');
  assert.equal(startupStatus(prev, { ...base, version: '1.5.0', schemaVersion: 2 }, AT).readOnly, false, 'updated code starts writable');
  assert.equal(startupStatus(null, base, AT).readOnly, false);
});

test('write/read the status file', () => {
  const dir = tmp();
  writeVersionStatus(dir, status({ version: '2.0.0' }));
  assert.equal(readVersionStatus(dir)?.version, '2.0.0');
});

// ── the daemon's decision ───────────────────────────────────────────────────

test('decideVersion: behind on version → banner state, one notice, auto-update once an hour', () => {
  const now = Date.parse(AT);
  const d = decideVersion({ prev: status(), settings: { version: '1.5.0', schemaVersion: 1 }, code: release('1.4.2'), mode: 'marketplace', update: null, now, alive: () => false });
  assert.equal(d.status.versionBehind, true);
  assert.equal(d.status.readOnly, false, 'behind only on version: keeps working');
  assert.equal(d.launchUpdate, true);
  assert.equal(d.notice, 'ks-flow on Mac A is behind (1.4.2 → 1.5.0): updating');

  // The update runs: no second launch, no second notice.
  const running: UpdateState = { state: 'running', startedAt: AT, pid: 4242 };
  const d2 = decideVersion({ prev: d.status, settings: { version: '1.5.0', schemaVersion: 1 }, code: release('1.4.2'), mode: 'marketplace', update: running, now: now + 60_000, alive: () => true });
  assert.equal(d2.launchUpdate, false);
  assert.equal(d2.notice, null);

  // It failed: a notice with the reason; the retry waits an hour.
  const failed: UpdateState = { state: 'failed', startedAt: AT, reason: 'marketplace failed (exit 1)' };
  const d3 = decideVersion({ prev: d2.status, settings: { version: '1.5.0', schemaVersion: 1 }, code: release('1.4.2'), mode: 'marketplace', update: failed, now: now + 120_000, alive: () => false });
  assert.equal(d3.launchUpdate, false);
  assert.equal(d3.notice, 'ks-flow on Mac A is behind (1.4.2 → 1.5.0): run `ks-flow update` (marketplace failed (exit 1))');

  // An hour on: it tries again, quietly (same target).
  const d4 = decideVersion({ prev: d3.status, settings: { version: '1.5.0', schemaVersion: 1 }, code: release('1.4.2'), mode: 'marketplace', update: failed, now: now + UPDATE_RETRY_MS, alive: () => false });
  assert.equal(d4.launchUpdate, true);
  assert.equal(d4.notice, null);
});

test('decideVersion: a dev build never auto-updates; it says why', () => {
  const dev = { ...release('1.4.2'), dev: true, devReason: 'on branch feat/x, not main' };
  const d = decideVersion({ prev: status(), settings: { version: '1.5.0', schemaVersion: 1 }, code: dev, mode: 'clone', update: null, now: Date.parse(AT), alive: () => false });
  assert.equal(d.launchUpdate, false);
  assert.match(d.notice ?? '', /run `ks-flow update` \(dev build: on branch feat\/x, not main\)/);
});

test('decideVersion: up to date → no notice, and the last notice is cleared', () => {
  const d = decideVersion({ prev: status({ notified: 'old' }), settings: { version: '1.4.2', schemaVersion: 1 }, code: release('1.4.2'), mode: 'marketplace', update: null, now: Date.parse(AT), alive: () => false });
  assert.equal(d.notice, null);
  assert.equal(d.launchUpdate, false);
  assert.equal(d.status.notified, null);
});

test('mayAutoUpdate: not while one runs, not within the hour', () => {
  const now = Date.parse(AT);
  assert.equal(mayAutoUpdate(null, now, () => false), true);
  assert.equal(mayAutoUpdate({ state: 'running', startedAt: '2026-11-15T00:00:00Z', pid: 1 }, now, () => true), false);
  assert.equal(mayAutoUpdate({ state: 'ok', startedAt: new Date(now - 10 * 60_000).toISOString() }, now, () => false), false);
  assert.equal(mayAutoUpdate({ state: 'failed', startedAt: new Date(now - UPDATE_RETRY_MS).toISOString() }, now, () => false), true);
});

test('behindMessage: the data format says the board is read-only', () => {
  const m = behindMessage(status({ storeVersion: '2.0.0', storeSchemaVersion: 2, versionBehind: true, schemaBehind: true }), true);
  assert.equal(m, 'ks-flow on Mac A is behind (1.4.2 → 2.0.0); its board is read-only: updating');
});

// ── the release check (ks-setup update --check) ─────────────────────────────

const ago = (ms: number): string => new Date(Date.parse(AT) - ms).toISOString();
const check = (over: Partial<ReleaseCheck> = {}): ReleaseCheck => ({
  checkedAt: AT,
  state: 'available',
  plugins: [
    { plugin: 'ks', installed: '1.0.6', latest: '1.1.0' },
    { plugin: 'ks-flow', installed: '0.2.2', latest: '0.3.0' },
    { plugin: 'ks-master', installed: '0.1.0', latest: '0.1.0' },
  ],
  reason: null,
  ...over,
});

test('decideRelease: first time, then at most hourly', () => {
  const now = Date.parse(AT);
  assert.equal(decideRelease(null, now, release('0.2.2'), null), true, 'never checked');
  assert.equal(decideRelease(check({ checkedAt: ago(10 * 60_000) }), now, release('0.2.2'), null), false);
  assert.equal(decideRelease(check({ checkedAt: ago(RELEASE_CHECK_MS - 1) }), now, release('0.2.2'), null), false);
  assert.equal(decideRelease(check({ checkedAt: ago(RELEASE_CHECK_MS) }), now, release('0.2.2'), null), true);
  assert.equal(decideRelease(check({ checkedAt: null, state: 'busy' }), now, release('0.2.2'), null), true, 'no answer yet');
});

test('decideRelease: a dev build never checks', () => {
  const dev = { ...release('0.2.2'), dev: true, devReason: 'on branch feat/x, not main' };
  assert.equal(decideRelease(null, Date.parse(AT), dev, null), false);
  assert.equal(decideRelease(check({ checkedAt: ago(5 * RELEASE_CHECK_MS) }), Date.parse(AT), dev, null), false);
});

test('decideRelease: not while an update runs; at once after one succeeded; 10 min after busy', () => {
  const now = Date.parse(AT);
  const old = check({ checkedAt: ago(2 * RELEASE_CHECK_MS) });
  const running: UpdateState = { state: 'running', startedAt: ago(60_000), pid: 4242 };
  assert.equal(decideRelease(old, now, release('0.2.2'), running, () => true), false, 'its pid lives');
  assert.equal(decideRelease(old, now, release('0.2.2'), running, () => false), true, 'a dead pid is no update');
  // Checked 5 min ago, an update ended 1 min ago: the answer is out of date.
  const recent = check({ checkedAt: ago(5 * 60_000) });
  const ok: UpdateState = { state: 'ok', startedAt: ago(4 * 60_000), endedAt: ago(60_000) };
  assert.equal(decideRelease(recent, now, release('0.3.0'), ok), true);
  assert.equal(decideRelease(recent, now, release('0.2.2'), { ...ok, state: 'failed' }), false, 'a failed one changes nothing');
  // ks-setup was busy 5 min ago: wait; 10 min on: try.
  assert.equal(decideRelease(check({ checkedAt: ago(2 * RELEASE_CHECK_MS), busyAt: ago(5 * 60_000) }), now, release('0.2.2'), null), false);
  assert.equal(decideRelease(check({ checkedAt: ago(2 * RELEASE_CHECK_MS), busyAt: ago(RELEASE_BUSY_RETRY_MS) }), now, release('0.2.2'), null), true);
});

test('releaseCheckFrom: ks-setup --check JSON → the record; busy keeps the last answer', () => {
  const json = {
    state: 'available',
    mode: 'marketplace',
    plugins: [
      { plugin: 'ks', from: '1.0.6', to: '1.1.0', projects: [] },
      { plugin: 'ks-flow', from: '0.2.2', to: '0.3.0', projects: [] },
    ],
    reason: null,
  };
  assert.deepEqual(releaseCheckFrom({ code: 0, json, out: '' }, null, AT), {
    checkedAt: AT,
    state: 'available',
    plugins: [
      { plugin: 'ks', installed: '1.0.6', latest: '1.1.0' },
      { plugin: 'ks-flow', installed: '0.2.2', latest: '0.3.0' },
    ],
    reason: null,
  });
  const prev = check({ checkedAt: ago(RELEASE_CHECK_MS) });
  const busy = releaseCheckFrom({ code: 3, json: { state: 'busy', reason: 'another update is running (pid 1)' }, out: '' }, prev, AT);
  assert.deepEqual(busy, { ...prev, busyAt: AT });
  assert.equal(releaseCheckFrom({ code: 3, json: null, out: '' }, null, AT).checkedAt, null, 'busy before any answer: still none');
  assert.equal(releaseCheckFrom({ code: 2, json: null, out: 'usage' }, null, AT).state, 'refused', 'an older ks');
  const bad = releaseCheckFrom({ code: 1, json: null, out: 'zsh: command not found\n' }, null, AT);
  assert.equal(bad.state, 'failed');
  assert.match(bad.reason ?? '', /exit 1\): zsh: command not found/);
  const refused = releaseCheckFrom({ code: 1, json: { state: 'refused', reason: 'claude is not on PATH' }, out: '' }, null, AT);
  assert.deepEqual([refused.state, refused.reason], ['refused', 'claude is not on PATH']);

  const dir = tmp();
  writeReleaseCheck(dir, busy);
  assert.deepEqual(readReleaseCheck(dir), busy);
});

test('currentRelease: none for a dev build, before any answer, or once an update succeeded after it', () => {
  assert.equal(currentRelease(check(), null, { dev: true }), null);
  assert.equal(currentRelease(check({ checkedAt: null, state: 'busy' }), null, { dev: false }), null);
  assert.equal(currentRelease(check(), { state: 'ok', startedAt: AT, endedAt: new Date(Date.parse(AT) + 60_000).toISOString() }, { dev: false }), null);
  const r = currentRelease(check({ busyAt: AT }), { state: 'failed', startedAt: AT, endedAt: AT }, { dev: false });
  assert.deepEqual(Object.keys(r ?? {}).sort(), ['checkedAt', 'plugins', 'reason', 'state'], "ks-setup doctor's shape, no busyAt");
});

test('behindMessage: a new release names what is newer; the store being ahead comes first', () => {
  const rel = currentRelease(check(), null, { dev: false });
  assert.equal(behindMessage(status({ release: rel }), true), 'a new KS release on Mac A (ks 1.1.0, ks-flow 0.3.0): updating');
  assert.equal(
    behindMessage(status({ release: rel, update: { state: 'failed', startedAt: AT, reason: 'ks-setup update failed: boom' } }), false),
    'a new KS release on Mac A (ks 1.1.0, ks-flow 0.3.0): run `ks-setup update` (ks-setup update failed: boom)',
  );
  assert.equal(behindMessage(status({ release: { ...rel!, state: 'current' } }), false), null);
  assert.equal(
    behindMessage(status({ release: rel, storeVersion: '1.5.0', versionBehind: true }), true),
    'ks-flow on Mac A is behind (1.4.2 → 1.5.0): updating',
  );
});

test('behindMessage / mayAutoUpdate: "busy" (another update holds the lock) is being updated, never "update by hand"', () => {
  const now = Date.parse(AT);
  const busy: UpdateState = { state: 'busy', startedAt: ago(60_000), endedAt: ago(60_000), reason: 'another update is running' };
  const m = behindMessage(status({ storeVersion: '1.5.0', versionBehind: true, update: busy }), false);
  assert.equal(m, 'ks-flow on Mac A is behind (1.4.2 → 1.5.0): updating');
  assert.equal(behindMessage(status({ update: busy }), false), null, 'up to date: nothing to say');
  assert.equal(mayAutoUpdate(busy, now, () => false), false);
  assert.equal(mayAutoUpdate({ ...busy, endedAt: ago(UPDATE_BUSY_RETRY_MS) }, now, () => false), true, 'retried 10 min on, not an hour');

  // The daemon: the notice it sent when launching is not followed by "update by hand".
  const settings = { version: '1.5.0', schemaVersion: 1 };
  const d1 = decideVersion({ prev: status(), settings, code: release('1.4.2'), mode: 'marketplace', update: null, now, alive: () => false });
  assert.equal(d1.notice, 'ks-flow on Mac A is behind (1.4.2 → 1.5.0): updating');
  const d2 = decideVersion({ prev: d1.status, settings, code: release('1.4.2'), mode: 'marketplace', update: busy, now, alive: () => false });
  assert.equal(d2.notice, null);
  assert.equal(d2.launchUpdate, false);
  const d3 = decideVersion({ prev: d2.status, settings, code: release('1.4.2'), mode: 'marketplace', update: busy, now: now + UPDATE_BUSY_RETRY_MS, alive: () => false });
  assert.equal(d3.launchUpdate, true);
  assert.equal(d3.notice, null);
});

test('decideVersion: a new release → one notice per target, the update started, quiet retries', () => {
  const now = Date.parse(AT);
  const code = release('0.2.2');
  const base = { settings: { version: '0.2.2', schemaVersion: 1 }, code, mode: 'marketplace' as const };
  const d1 = decideVersion({ ...base, prev: status({ version: '0.2.2' }), update: null, release: check(), now, alive: () => false });
  assert.equal(d1.launchUpdate, true);
  assert.equal(d1.notice, 'a new KS release on Mac A (ks 1.1.0, ks-flow 0.3.0): updating');
  assert.equal(d1.status.release?.state, 'available');

  // It runs: no second launch, no second notice.
  const running: UpdateState = { state: 'running', startedAt: AT, pid: 4242 };
  const d2 = decideVersion({ ...base, prev: d1.status, update: running, release: check(), now: now + 60_000, alive: () => true });
  assert.deepEqual([d2.launchUpdate, d2.notice], [false, null]);

  // It failed: one notice with the reason; an hour on it retries quietly.
  const failed: UpdateState = { state: 'failed', startedAt: AT, endedAt: AT, reason: 'ks-setup update failed: boom' };
  const d3 = decideVersion({ ...base, prev: d2.status, update: failed, release: check(), now: now + 120_000, alive: () => false });
  assert.equal(d3.launchUpdate, false);
  assert.equal(d3.notice, 'a new KS release on Mac A (ks 1.1.0, ks-flow 0.3.0): run `ks-setup update` (ks-setup update failed: boom)');
  const d4 = decideVersion({ ...base, prev: d3.status, update: failed, release: check(), now: now + UPDATE_RETRY_MS, alive: () => false });
  assert.deepEqual([d4.launchUpdate, d4.notice], [true, null], 'same target: no second notice');

  // A newer release is a new target: a new notice.
  const newer = check({ plugins: [{ plugin: 'ks', installed: '1.0.6', latest: '1.2.0' }] });
  const d5 = decideVersion({ ...base, prev: d4.status, update: running, release: newer, now: now + UPDATE_RETRY_MS + 60_000, alive: () => true });
  assert.equal(d5.notice, 'a new KS release on Mac A (ks 1.2.0): updating');

  // It succeeded after the check: the answer is out of date (no release shown, no launch) until the re-check.
  const ok: UpdateState = { state: 'ok', startedAt: AT, endedAt: new Date(now + 2 * UPDATE_RETRY_MS).toISOString() };
  const d6 = decideVersion({ ...base, prev: d5.status, update: ok, release: newer, now: now + 2 * UPDATE_RETRY_MS + 60_000, alive: () => false });
  assert.deepEqual([d6.launchUpdate, d6.notice, d6.status.release, d6.status.notified], [false, null, null, null]);
});

test('decideVersion: a dev build ignores a release check (none shown, no update)', () => {
  const dev = { ...release('0.2.2'), dev: true, devReason: 'uncommitted changes' };
  const d = decideVersion({ prev: status({ version: '0.2.2' }), settings: null, code: dev, mode: 'clone', update: null, release: check(), now: Date.parse(AT), alive: () => false });
  assert.deepEqual([d.launchUpdate, d.notice, d.status.release], [false, null, null]);
});

test('decideVersion: an install that is neither clone nor marketplace says "update by hand"', () => {
  const d = decideVersion({ prev: status({ version: '0.2.2' }), settings: null, code: release('0.2.2'), mode: 'unknown', update: null, release: check(), now: Date.parse(AT), alive: () => false });
  assert.equal(d.launchUpdate, false);
  assert.equal(d.notice, 'a new KS release on Mac A (ks 1.1.0, ks-flow 0.3.0): run `ks-setup update` (update by hand)');
});

// ── build info and the clone update, with a fake git ────────────────────────

/** A git that answers like a clone at `top` on `branch`, dirty or not. */
function fakeGit(o: { top?: string | null; branch?: string | null; dirty?: boolean }): Git & { calls: string[][] } {
  const calls: string[][] = [];
  const g = ((args: string[]) => {
    calls.push(args);
    const cmd = args.join(' ');
    if (cmd === 'rev-parse --show-toplevel') {
      if (!o.top) throw new Error('not a git repository');
      return o.top;
    }
    if (cmd.startsWith('symbolic-ref')) {
      if (!o.branch) throw new Error('detached');
      return o.branch;
    }
    if (cmd.startsWith('status --porcelain')) return o.dirty ? ' M plugins/ks-flow/src/daemon.ts' : '';
    throw new Error(`unexpected git ${cmd}`);
  }) as Git & { calls: string[][] };
  g.calls = calls;
  return g;
}

test('clone update: allowed on main with a clean tree → git pull --ff-only in the top folder', () => {
  const root = tmp();
  const plan = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({ top: '/repo', branch: 'main' }), home: '/nohome' });
  assert.deepEqual(plan, { ok: true, mode: 'clone', repo: '/repo', steps: [{ label: 'git pull', cmd: 'git', args: ['pull', '--ff-only'], cwd: '/repo' }] });
});

test('clone update: refused off main, on a detached HEAD, or with uncommitted changes', () => {
  const root = tmp();
  const off = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({ top: '/repo', branch: 'feat/x' }), home: '/nohome' });
  assert.deepEqual(off, { ok: false, reason: 'the clone is on branch feat/x, not main' });
  const detached = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({ top: '/repo', branch: null }), home: '/nohome' });
  assert.equal(detached.ok, false);
  const dirty = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({ top: '/repo', branch: 'main', dirty: true }), home: '/nohome' });
  assert.deepEqual(dirty, { ok: false, reason: 'the clone has uncommitted changes' });
  const none = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({ top: null }), home: '/nohome' });
  assert.equal(none.ok, false);
});

test('marketplace update: the claude plugin commands, in the KarmaSuite checkout, local scope', () => {
  const home = tmp();
  const root = join(home, '.claude', 'plugins', 'cache', 'karmasuite', 'ks-flow', '1.4.2');
  mkdirSync(root, { recursive: true });
  const proj = tmp();
  assert.equal(marketplaceOf(root, home), 'karmasuite');
  const git = fakeGit({ top: '/should-not-be-asked' });
  const plan = planUpdate({ pluginRoot: root, projectPath: proj, git, home });
  assert.equal(plan.ok, true);
  if (!plan.ok || plan.mode !== 'marketplace') throw new Error('expected a marketplace plan');
  assert.deepEqual(
    plan.steps.map((s) => [s.cmd, ...s.args].join(' ')),
    [
      'claude plugin marketplace update karmasuite',
      'claude plugin update ks-flow@karmasuite --scope local',
      'claude plugin update ks@karmasuite --scope local',
    ],
  );
  assert.ok(plan.steps.every((s) => s.cwd === proj && s.login));
  assert.equal(git.calls.length, 0, 'an installed copy is not a clone');
  assert.equal(planUpdate({ pluginRoot: root, projectPath: null, git, home }).ok, false, 'needs the project path');
});

test('newestCachedRoot: the highest plugin.json version', () => {
  const home = tmp();
  for (const v of ['1.4.2', '1.10.0', '1.9.9']) {
    const d = join(home, '.claude', 'plugins', 'cache', 'karmasuite', 'ks-flow', v, '.claude-plugin');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'ks-flow', version: v }));
  }
  assert.match(newestCachedRoot('karmasuite', 'ks-flow', home) ?? '', /1\.10\.0$/);
});

test('detectBuild: plugin.json version from build.json; a dirty clone is a dev build', () => {
  const daemonDir = tmp();
  const root = tmp();
  writeFileSync(join(daemonDir, 'build.json'), JSON.stringify({ version: '1.5.0', pluginRoot: root }));
  const b = detectBuild({ daemonDir, findRoot: () => null, fallbackVersion: '0.1.0', git: fakeGit({ top: '/repo', branch: 'main', dirty: true }), home: '/nohome' });
  assert.deepEqual(b, { version: '1.5.0', pluginRoot: root, mode: 'clone', dev: true, devReason: 'uncommitted changes' });
  const clean = detectBuild({ daemonDir, findRoot: () => null, fallbackVersion: '0.1.0', git: fakeGit({ top: '/repo', branch: 'main' }), home: '/nohome' });
  assert.equal(clean.dev, false);
  // No build.json: the found root's plugin.json.
  const noFile = tmp();
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.6.0' }));
  const found = detectBuild({ daemonDir: noFile, findRoot: () => root, fallbackVersion: '0.1.0', git: fakeGit({ top: null }), home: '/nohome' });
  assert.deepEqual(found, { version: '1.6.0', pluginRoot: root, mode: 'unknown', dev: false, devReason: null });
});

test('cloneState / devReason / installMode', () => {
  const c = cloneState('/x', fakeGit({ top: '/repo', branch: 'main' }));
  assert.deepEqual(c, { top: '/repo', branch: 'main', dirty: false });
  assert.equal(devReason(c!), null);
  assert.equal(installMode('/home/u/.claude/plugins/cache/karmasuite/ks-flow/1.0.0', null, '/home/u'), 'marketplace');
  assert.equal(installMode('/repo/plugins/ks-flow', c, '/home/u'), 'clone');
  assert.equal(installMode(null, null, '/home/u'), 'unknown');
});

test('runUpdate: refused writes the reason and runs nothing', () => {
  const states: UpdateState[] = [];
  const ran: Step[] = [];
  const out = runUpdate({
    plan: { ok: false, reason: 'the clone has uncommitted changes' },
    fromVersion: '1.4.2',
    by: 'auto',
    run: (s) => (ran.push(s), { code: 0, out: '' }),
    newRoot: () => null,
    bootstrap: () => ({ code: 0, out: '' }),
    restartDaemon: () => ({ code: 0, out: '' }),
    restartBoard: () => null,
    writeState: (s) => states.push(s),
    log: () => {},
  });
  assert.equal(out.state, 'refused');
  assert.equal(out.reason, 'the clone has uncommitted changes');
  assert.equal(ran.length, 0);
  assert.equal(states.at(-1)?.state, 'refused');
});

test('runUpdate: new code → rebuild → restart daemon → board; a failing step stops it with the reason', () => {
  const root = tmp();
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.5.0' }));
  const order: string[] = [];
  const plan = { ok: true as const, mode: 'clone' as const, repo: '/repo', steps: [{ label: 'git pull', cmd: 'git', args: ['pull', '--ff-only'], cwd: '/repo' }] };
  const base = {
    plan,
    fromVersion: '1.4.2',
    by: 'manual' as const,
    newRoot: () => root,
    writeState: () => {},
    log: () => {},
  };
  const ok = runUpdate({
    ...base,
    run: (s) => (order.push(s.label), { code: 0, out: '' }),
    bootstrap: () => (order.push('bootstrap'), { code: 0, out: '' }),
    restartDaemon: () => (order.push('daemon'), { code: 0, out: '' }),
    restartBoard: () => (order.push('board'), { code: 0, out: '' }),
  });
  assert.deepEqual(order, ['git pull', 'bootstrap', 'daemon', 'board']);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.to, '1.5.0');

  const failed = runUpdate({
    ...base,
    run: () => ({ code: 1, out: 'fatal: Not possible to fast-forward, aborting.\n' }),
    bootstrap: () => assert.fail('no rebuild after a failed pull'),
    restartDaemon: () => assert.fail('no restart'),
    restartBoard: () => assert.fail('no restart'),
  });
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason ?? '', /git pull failed \(exit 1\): fatal: Not possible to fast-forward/);
});

// ── the board's twin (web/lib/versioning.ts) ────────────────────────────────

test('web compareSemver gives the same order as the daemon', async () => {
  const web = await import('../../web/lib/versioning.ts');
  const pairs: Array<[unknown, unknown]> = [
    ['1.10.0', '1.9.0'],
    ['1.5.0-rc.1', '1.5.0'],
    ['1.5.0-rc.2', '1.5.0-rc.10'],
    ['1.5.0-alpha', '1.5.0-1'],
    ['unknown', '0.0.1'],
    ['2.0.0', '2.0.0'],
  ];
  for (const [a, b] of pairs) assert.equal(web.compareSemver(a, b), compareSemver(a, b), `${a} vs ${b}`);
});

test('web versionNotices: every device behind, by name; this board red while read-only', async () => {
  const { versionNotices } = await import('../../web/lib/versioning.ts');
  const dev = (id: string, over: Record<string, unknown>) => ({
    deviceId: id,
    defaultName: `Mac ${id}`,
    platform: 'darwin',
    daemonVersion: '1.5.0',
    lastSeenAt: AT,
    projectPath: '/p',
    commonDir: '/p/.git',
    worktreePaths: [],
    inboxUrl: null,
    inboxRunning: false,
    linearCheckedAt: null,
    schemaVersion: 1,
    ...over,
  });
  const settings = { masterDeviceId: 'a', version: '1.5.0', schemaVersion: 1 };
  assert.deepEqual(versionNotices({ devices: [dev('a', {}), dev('b', {})], settings, self: 'a', local: null }), []);
  const behind = versionNotices({
    devices: [
      dev('a', {}),
      dev('b', { daemonVersion: '1.4.2', name: 'Studio' }),
      dev('c', { daemonVersion: '1.4.0', devBuild: true, devReason: 'uncommitted changes' }),
      dev('d', { daemonVersion: '1.0.0', forgotten: true }),
    ],
    settings,
    self: 'a',
    local: null,
  });
  assert.deepEqual(
    behind.map((n) => n.text),
    [
      'ks-flow on Studio is behind (1.4.2 → 1.5.0): updating.',
      'ks-flow on Mac c is behind (1.4.0 → 1.5.0): dev build: uncommitted changes — run ks-flow update there.',
    ],
  );
  const ro = versionNotices({
    devices: [dev('a', { daemonVersion: '1.4.2' })],
    settings: { ...settings, schemaVersion: 2 },
    self: 'a',
    local: status({ deviceId: 'a', storeVersion: '1.5.0', storeSchemaVersion: 2, versionBehind: true, schemaBehind: true, readOnly: true }),
  });
  assert.equal(ro.length, 1, 'this device is told once, from its own status');
  assert.equal(ro[0].tone, 'red');
  assert.match(ro[0].text, /^This board is read-only/);
});

test('web versionNotices: a new release found by the daemon, for this device', async () => {
  const { versionNotices } = await import('../../web/lib/versioning.ts');
  const rel = currentRelease(check(), null, { dev: false });
  const settings = { masterDeviceId: 'a', version: '0.2.2', schemaVersion: 1 };
  const n = versionNotices({ devices: [], settings, self: 'a', local: status({ deviceId: 'a', version: '0.2.2', storeVersion: '0.2.2', release: rel }) });
  assert.deepEqual(n.map((x) => [x.key, x.tone, x.text]), [['self-release', 'amber', 'A new KS release for this device (ks 1.1.0, ks-flow 0.3.0): updating.']]);
  const failed = versionNotices({
    devices: [],
    settings,
    self: 'a',
    local: status({ deviceId: 'a', version: '0.2.2', release: rel, update: { state: 'failed', startedAt: AT, reason: 'boom' } }),
  });
  assert.equal(failed[0].text, 'A new KS release for this device (ks 1.1.0, ks-flow 0.3.0): run ks-setup update (boom).');
  const current = versionNotices({ devices: [], settings, self: 'a', local: status({ deviceId: 'a', version: '0.2.2', release: { ...rel!, state: 'current' } }) });
  assert.deepEqual(current, []);
});
