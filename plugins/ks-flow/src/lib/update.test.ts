// Tests for lib/update.ts's delegation to ks's `ks-setup update`: the step's
// argv, the old steps on exit 2 (an older ks), "busy" on exit 3 (no failure
// state written), ks-setup's JSON verdicts, and --no-fetch (no steps, straight
// to rebuild and restart). A stub ks-setup script checks the real stdout/argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Git } from './build-info.js';
import { changedPlugins, parseKsSetup, planUpdate, runUpdate, type RunResult, type Step, type UpdateDeps, type UpdatePlan } from './update.js';
import type { UpdateState } from './versioning.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ksflow-update-'));

function fakeGit(o: { top?: string | null; branch?: string | null; dirty?: boolean }): Git {
  return ((args: string[]) => {
    const cmd = args.join(' ');
    if (cmd === 'rev-parse --show-toplevel') {
      if (!o.top) throw new Error('not a git repository');
      return o.top;
    }
    if (cmd.startsWith('symbolic-ref')) {
      if (!o.branch) throw new Error('detached');
      return o.branch;
    }
    if (cmd.startsWith('status --porcelain')) return o.dirty ? ' M x' : '';
    throw new Error(`unexpected git ${cmd}`);
  }) as Git;
}

/** A home with an installed ks-flow at cache/karmasuite/ks-flow/<v>. */
function installed(v = '0.2.2'): { home: string; root: string; proj: string } {
  const home = tmp();
  const root = join(home, '.claude', 'plugins', 'cache', 'karmasuite', 'ks-flow', v);
  mkdirSync(root, { recursive: true });
  return { home, root, proj: tmp() };
}

/** A plugin folder whose plugin.json says `version`. */
function pluginDir(version: string): string {
  const root = tmp();
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ks-flow', version }));
  return root;
}

const line = (s: Step): string => [s.cmd, ...s.args].join(' ');
const OLD_MARKET = [
  'claude plugin marketplace update karmasuite',
  'claude plugin update ks-flow@karmasuite --scope local',
  'claude plugin update ks@karmasuite --scope local',
];

function json(o: Record<string, unknown>): string {
  return JSON.stringify({ state: 'updated', mode: 'marketplace', plugins: [], reason: null, log: '/cfg/update.log', by: 'manual', restarted: false, ...o });
}

/** runUpdate with recording fakes; `ksSetup` answers the ks-setup step, other steps pass. */
function harness(plan: UpdatePlan, ksSetup: (s: Step) => RunResult, newRoot = pluginDir('0.3.0')) {
  const order: string[] = [];
  const states: UpdateState[] = [];
  const logs: string[] = [];
  const deps: UpdateDeps = {
    plan,
    fromVersion: '0.2.2',
    by: 'auto',
    run: (s) => (order.push(s.ksSetup ? 'ks-setup' : line(s)), s.ksSetup ? ksSetup(s) : { code: 0, out: '' }),
    newRoot: () => newRoot,
    bootstrap: () => (order.push('bootstrap'), { code: 0, out: '' }),
    restartDaemon: () => (order.push('daemon'), { code: 0, out: '' }),
    restartBoard: () => (order.push('board'), { code: 0, out: '' }),
    writeState: (s) => states.push(s),
    log: (m) => logs.push(m),
  };
  return { deps, order, states, logs, out: () => runUpdate(deps) };
}

// ── the plan ────────────────────────────────────────────────────────────────

test('delegation: installed → one ks-setup step in the checkout, login shell; the old steps as fallback', () => {
  const { home, root, proj } = installed();
  const plan = planUpdate({ pluginRoot: root, projectPath: proj, git: fakeGit({}), home, ksSetup: '/ks/scripts/ks-setup' });
  if (!plan.ok || plan.mode !== 'marketplace') throw new Error('expected a marketplace plan');
  assert.deepEqual(plan.steps.map(line), ['/ks/scripts/ks-setup update --no-restart --json']);
  assert.equal(plan.steps[0].cwd, proj);
  assert.equal(plan.steps[0].login, true);
  assert.equal(plan.steps[0].ksSetup, true);
  assert.deepEqual(plan.fallback?.map(line), OLD_MARKET);
  assert.ok(plan.fallback?.every((s) => s.cwd === proj && s.login && !s.ksSetup));

  const auto = planUpdate({ pluginRoot: root, projectPath: proj, git: fakeGit({}), home, ksSetup: '/ks/scripts/ks-setup', auto: true });
  assert.deepEqual(auto.ok && auto.steps.map(line), ['/ks/scripts/ks-setup update --no-restart --json --auto']);
});

test('delegation: a clean main clone → ks-setup in the clone (it pulls), git pull as fallback', () => {
  const plan = planUpdate({ pluginRoot: tmp(), projectPath: null, git: fakeGit({ top: '/repo', branch: 'main' }), home: '/nohome', ksSetup: '/repo/plugins/ks/scripts/ks-setup' });
  if (!plan.ok || plan.mode !== 'clone') throw new Error('expected a clone plan');
  assert.deepEqual(plan.steps.map(line), ['/repo/plugins/ks/scripts/ks-setup update --no-restart --json']);
  assert.equal(plan.steps[0].cwd, '/repo');
  assert.deepEqual(plan.fallback, [{ label: 'git pull', cmd: 'git', args: ['pull', '--ff-only'], cwd: '/repo' }]);
});

test('delegation: no ks-setup found → the old steps alone, exactly as before', () => {
  const { home, root, proj } = installed();
  const plan = planUpdate({ pluginRoot: root, projectPath: proj, git: fakeGit({}), home, ksSetup: null });
  assert.deepEqual(plan.ok && plan.steps.map(line), OLD_MARKET);
  assert.equal(plan.ok && plan.fallback, undefined);
});

test('delegation: the refusals and their reasons are unchanged', () => {
  const ks = '/ks/scripts/ks-setup';
  const p = (git: Git) => planUpdate({ pluginRoot: tmp(), projectPath: null, git, home: '/nohome', ksSetup: ks });
  assert.deepEqual(p(fakeGit({ top: '/repo', branch: 'feat/x' })), { ok: false, reason: 'the clone is on branch feat/x, not main' });
  assert.deepEqual(p(fakeGit({ top: '/repo', branch: null })), { ok: false, reason: 'the clone is not on a branch (detached HEAD)' });
  assert.deepEqual(p(fakeGit({ top: '/repo', branch: 'main', dirty: true })), { ok: false, reason: 'the clone has uncommitted changes' });
  const { home, root } = installed();
  assert.deepEqual(planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({}), home, ksSetup: ks }), {
    ok: false,
    reason: 'the KarmaSuite checkout (the project path) is unknown: the plugins are installed per project',
  });
  assert.deepEqual(planUpdate({ pluginRoot: null, projectPath: null, git: fakeGit({}), ksSetup: ks }), { ok: false, reason: "ks-flow's plugin folder is unknown" });
});

test('--no-fetch: no steps (a clone off main or dirty is fine: nothing is pulled); no plugin folder still refuses', () => {
  const dirty = planUpdate({ pluginRoot: tmp(), projectPath: null, git: fakeGit({ top: '/repo', branch: 'feat/x', dirty: true }), home: '/nohome', noFetch: true });
  assert.deepEqual(dirty, { ok: true, mode: 'clone', repo: '/repo', steps: [] });
  const { home, root } = installed();
  assert.deepEqual(planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({}), home, noFetch: true }), { ok: true, mode: 'marketplace', marketplace: 'karmasuite', steps: [] });
  assert.equal(planUpdate({ pluginRoot: tmp(), projectPath: null, git: fakeGit({ top: null }), home: '/nohome', noFetch: true }).ok, false);
  assert.equal(planUpdate({ pluginRoot: null, projectPath: null, git: fakeGit({}), noFetch: true }).ok, false);
});

// ── the run ─────────────────────────────────────────────────────────────────

function delegatingPlan(): UpdatePlan {
  const { home, root, proj } = installed();
  return planUpdate({ pluginRoot: root, projectPath: proj, git: fakeGit({}), home, ksSetup: '/ks/scripts/ks-setup', auto: true });
}

test('runUpdate: ks-setup updated → no old steps → rebuild → daemon → board, ok', () => {
  const stdout = `${json({ plugins: [{ plugin: 'ks', from: '1.0.6', to: '1.1.0' }, { plugin: 'ks-flow', from: '0.2.2', to: '0.3.0' }, { plugin: 'ks-master', from: '0.1.0', to: '0.1.0' }] })}\n`;
  const h = harness(delegatingPlan(), () => ({ code: 0, out: `updating ks\n${stdout}`, stdout }));
  const out = h.out();
  assert.deepEqual(h.order, ['ks-setup', 'bootstrap', 'daemon', 'board']);
  assert.equal(out.state, 'ok');
  assert.equal(out.state === 'ok' && out.to, '0.3.0');
  assert.ok(h.logs.some((l) => l.includes('ks 1.0.6 → 1.1.0, ks-flow 0.2.2 → 0.3.0') && l.includes('/cfg/update.log')), h.logs.join('\n'));
});

test('runUpdate: ks-setup current → still rebuild and restart (as the old claude steps did)', () => {
  const stdout = json({ state: 'current', plugins: [{ plugin: 'ks-flow', from: '0.2.2', to: '0.2.2' }] });
  const h = harness(delegatingPlan(), () => ({ code: 0, out: stdout, stdout }));
  assert.equal(h.out().state, 'ok');
  assert.deepEqual(h.order, ['ks-setup', 'bootstrap', 'daemon', 'board']);
  assert.ok(h.logs.some((l) => l.includes('ks-setup update current: nothing new')));
});

test('runUpdate: ks-setup exit 2 (an older ks) → the old claude steps, then rebuild and restart', () => {
  const h = harness(delegatingPlan(), () => ({ code: 2, out: 'ks-setup: unknown command: update\n', stdout: '' }));
  const out = h.out();
  assert.deepEqual(h.order, ['ks-setup', ...OLD_MARKET, 'bootstrap', 'daemon', 'board']);
  assert.equal(out.state, 'ok');
});

test('runUpdate: exit-2 fallback whose old step fails → failed with that step\'s reason', () => {
  const plan = delegatingPlan();
  const h = harness(plan, () => ({ code: 2, out: '', stdout: '' }));
  h.deps.run = (s) => (s.ksSetup ? { code: 2, out: '' } : s.label === 'ks-flow' ? { code: 1, out: 'boom\n' } : { code: 0, out: '' });
  const out = h.out();
  assert.equal(out.state, 'failed');
  assert.match(out.reason ?? '', /^ks-flow failed \(exit 1\): boom/);
});

test('runUpdate: exit 3 (another update runs) → busy: no rebuild; "busy" replaces the running record, never failed/refused', () => {
  const stdout = json({ state: 'busy', mode: null, reason: 'another update is running (pid 4242)' });
  const h = harness(delegatingPlan(), () => ({ code: 3, out: stdout, stdout }));
  const out = h.out();
  assert.equal(out.state, 'busy');
  assert.equal(out.reason, 'another update is running');
  assert.deepEqual(h.order, ['ks-setup']);
  assert.deepEqual(h.states.map((s) => s.state), ['running', 'busy'], 'no "running" record left behind with a pid about to exit');
  assert.ok(h.states.at(-1)?.endedAt, 'busy is a finished record');
  assert.ok(h.logs.some((l) => l.includes('another update is running')));
});

test('runUpdate: exit 3 without JSON is busy too', () => {
  const h = harness(delegatingPlan(), () => ({ code: 3, out: '', stdout: '' }));
  assert.equal(h.out().state, 'busy');
});

test('runUpdate: ks-setup refused / failed → that state with its reason and log path; nothing restarted', () => {
  const refused = json({ state: 'refused', mode: 'clone', reason: 'the clone has no upstream' });
  const r = harness(delegatingPlan(), () => ({ code: 1, out: refused, stdout: refused }));
  const ro = r.out();
  assert.equal(ro.state, 'refused');
  assert.equal(ro.reason, 'ks-setup update refused: the clone has no upstream (log /cfg/update.log)');
  assert.deepEqual(r.order, ['ks-setup']);
  assert.equal(r.states.at(-1)?.state, 'refused');

  const failed = json({ state: 'failed', reason: 'claude plugin update ks@karmasuite failed in /p' });
  const f = harness(delegatingPlan(), () => ({ code: 1, out: failed, stdout: failed }));
  assert.equal(f.out().state, 'failed');
  assert.equal(f.states.at(-1)?.reason, 'ks-setup update failed: claude plugin update ks@karmasuite failed in /p (log /cfg/update.log)');

  // No JSON at all: the exit code and output tail.
  const n = harness(delegatingPlan(), () => ({ code: 1, out: 'bash: jq: command not found\n', stdout: '' }));
  const no = n.out();
  assert.equal(no.state, 'failed');
  assert.match(no.reason ?? '', /^ks-setup update failed \(exit 1\): bash: jq: command not found/);
});

test('--no-fetch: an empty plan goes straight to rebuild and restart', () => {
  const { home, root } = installed();
  const plan = planUpdate({ pluginRoot: root, projectPath: null, git: fakeGit({}), home, noFetch: true });
  const h = harness(plan, () => assert.fail('no fetch'));
  const out = h.out();
  assert.deepEqual(h.order, ['bootstrap', 'daemon', 'board']);
  assert.equal(out.state, 'ok');
  assert.deepEqual(h.states.map((s) => s.state), ['running', 'ok']);
});

// ── the JSON line ──────────────────────────────────────────────────────────

test('parseKsSetup: the JSON line among other output; changedPlugins lists only moved plugins', () => {
  const j = parseKsSetup(`not json\n{broken\n${json({ state: 'current' })}\n`);
  assert.equal(j?.state, 'current');
  assert.equal(parseKsSetup('nothing here\n'), null);
  assert.equal(parseKsSetup('{"other":1}\n'), null);
  assert.equal(changedPlugins({ state: 'updated', plugins: [{ plugin: 'ks', from: '1', to: '1' }] }), 'nothing new');
});

// ── a stub ks-setup on disk: the argv it gets and the stdout ks-flow reads ──

test('stub ks-setup: receives the delegation argv in the checkout; its stdout JSON drives the run', () => {
  const dir = tmp();
  const argvFile = join(dir, 'argv');
  const stub = join(dir, 'ks-setup');
  writeFileSync(
    stub,
    [
      '#!/bin/bash',
      `printf '%s\\n' "$PWD" "$@" > ${JSON.stringify(argvFile)}`,
      'echo "ks-setup: updating ks" >&2',
      `echo '${json({ plugins: [{ plugin: 'ks-flow', from: '0.2.2', to: '0.3.0', projects: [] }] })}'`,
      'exit 0',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);
  const { home, root, proj } = installed();
  const plan = planUpdate({ pluginRoot: root, projectPath: proj, git: fakeGit({}), home, ksSetup: stub, auto: true });
  const h = harness(plan, (s) => {
    const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
  });
  const out = h.out();
  assert.equal(out.state, 'ok');
  const [cwd, ...argv] = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.equal(cwd.replace(/^\/private/, ''), proj.replace(/^\/private/, ''));
  assert.deepEqual(argv, ['update', '--no-restart', '--json', '--auto']);
});
