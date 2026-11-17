import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryDocDb } from './db/docdb.js';
import { docDeviceStore } from './db/devicestore.js';
import type { DeviceCommandDoc } from './db/types.js';
import { DeviceCommandQueue, EXPIRE_MS, KEEP_MS, printed, refusal, runCommand, type Step } from './device-commands.js';

const root = mkdtempSync(join(tmpdir(), 'ksf-cmd-'));
const ctx = { projectPath: root, worktrees: () => [join(root, 'wt')] };
const NOW = Date.parse('2026-11-17T12:00:00Z');

function cmd(over: Partial<DeviceCommandDoc>): DeviceCommandDoc {
  return {
    uid: 'c1',
    to: 'dev-b',
    from: { deviceId: 'dev-a', by: 'ks-master' },
    command: 'ping',
    args: {},
    createdAt: new Date(NOW - 1000).toISOString(),
    status: 'queued',
    ...over,
  };
}

test('refusal: only known commands with checked arguments', () => {
  assert.equal(refusal({ command: 'ping', args: {} }, ctx), null);
  assert.match(refusal({ command: 'rm -rf' as never, args: {} }, ctx)!, /unknown command/);
  assert.equal(refusal({ command: 'start-ticket', args: { ticket: 'KAR-1' } }, ctx), null);
  assert.equal(refusal({ command: 'start-ticket', args: { ticket: 'https://linear.app/karmasuite/issue/KAR-1/x' } }, ctx), null);
  assert.match(refusal({ command: 'start-ticket', args: { ticket: 'KAR-1; rm -rf ~' } }, ctx)!, /needs a ticket/);
  assert.equal(refusal({ command: 'new-session', args: { dir: root } }, ctx), null);
  assert.match(refusal({ command: 'new-session', args: { dir: '/etc' } }, ctx)!, /not the KarmaSuite checkout/);
  assert.match(refusal({ command: 'new-session', args: { dir: 'wt' } }, ctx)!, /absolute/);
  assert.match(refusal({ command: 'restart-session', args: { ticket: '../x' } }, ctx)!, /needs a ticket/);
  assert.match(refusal({ command: 'backup', args: { unit: 'a b' } }, ctx)!, /unit/);
  assert.match(refusal({ command: 'new-session', args: { dir: root, prompt: 'run rm -rf ~' } as never }, ctx)!, /no free text/);
});

test('start-ticket: prepares, then opens the worktree printed by ks-start-ticket', async () => {
  const steps: Step[] = [];
  const out = await runCommand(
    { command: 'start-ticket', args: { ticket: 'KAR-9' } },
    ctx,
    async (s) => {
      steps.push(s);
      return s.name === 'ks-start-ticket'
        ? { code: 0, output: 'fetching…\nKS_WORKTREE=/wt/kar-9\nKS_PROMPT=/ks:project-manager go\n' }
        : { code: 0, output: 'claude-ks-start: opened' };
    },
    { version: '0.7.0', device: 'B' },
  );
  assert.deepEqual(
    steps.map((s) => [s.name, ...s.args]),
    [
      ['ks-start-ticket', 'KAR-9', '--no-launch'],
      ['claude-ks-start', '/wt/kar-9', '/ks:project-manager go'],
    ],
  );
  assert.equal(steps[0].cwd, root);
  assert.equal(out.status, 'ok');
  assert.match(out.message, /KAR-9: a new session in its worktree \/wt\/kar-9/);
});

test('start-ticket: no worktree printed → failed with the last line, nothing opened', async () => {
  const steps: string[] = [];
  const out = await runCommand(
    { command: 'start-ticket', args: { ticket: 'KAR-9' } },
    ctx,
    async (s) => {
      steps.push(s.name);
      return { code: 1, output: 'pnpm: command not found' };
    },
    { version: '0.7.0', device: 'B' },
  );
  assert.deepEqual(steps, ['ks-start-ticket']);
  assert.equal(out.status, 'failed');
  assert.match(out.message, /pnpm: command not found/);
});

test('printed: the last KEY= line', () => {
  assert.equal(printed('KS_WORKTREE=/a\nx\nKS_WORKTREE=/b\n', 'KS_WORKTREE'), '/b');
  assert.equal(printed('nothing', 'KS_WORKTREE'), null);
});

test('queue: runs a queued command once, writes the outcome; expires, refuses, interrupts, prunes', async () => {
  const db = new MemoryDocDb();
  const store = docDeviceStore(db);
  const ran: string[] = [];
  const logs: string[] = [];
  const q = new DeviceCommandQueue(
    store,
    async (d) => {
      ran.push(d.uid);
      return { status: 'ok', message: 'pong', output: '', exitCode: 0 };
    },
    (d) => refusal(d, ctx),
    (m) => logs.push(m),
    () => NOW,
  );
  const docs = [
    cmd({ uid: 'ok' }),
    cmd({ uid: 'old', createdAt: new Date(NOW - EXPIRE_MS - 1).toISOString() }),
    cmd({ uid: 'bad', command: 'restart-session', args: { ticket: 'nope' } }),
    cmd({ uid: 'stuck', status: 'running' }),
    cmd({ uid: 'gone', status: 'ok', endedAt: new Date(NOW - KEEP_MS - 1).toISOString() }),
  ];
  for (const d of docs) await store.addDeviceCommand!(d);
  await q.take(docs);
  await q.take(docs.map((d) => (d.uid === 'ok' ? { ...d, status: 'queued' as const } : d))); // a repeat delivery
  assert.deepEqual(ran, ['ok'], 'run once');
  const get = async (uid: string) => (await db.get(`deviceCommands/${uid}`)) as DeviceCommandDoc | null;
  assert.equal((await get('ok'))!.status, 'ok');
  assert.equal((await get('ok'))!.message, 'pong');
  assert.equal((await get('old'))!.status, 'expired');
  assert.equal((await get('bad'))!.status, 'refused');
  assert.equal((await get('stuck'))!.status, 'failed');
  assert.match((await get('stuck'))!.message!, /interrupted/);
  assert.equal(await get('gone'), null, 'pruned after 30 days');
});

test('queue: a command another run already took is not run again', async () => {
  const db = new MemoryDocDb();
  const store = docDeviceStore(db);
  const d = cmd({ uid: 'x' });
  await store.addDeviceCommand!(d);
  assert.equal(await store.claimDeviceCommand!('x', new Date(NOW).toISOString()), true);
  assert.equal(await store.claimDeviceCommand!('x', new Date(NOW).toISOString()), false);
});

test('the listener sees only this device\'s commands', () => {
  const db = new MemoryDocDb({
    'deviceCommands/a': { to: 'dev-a', command: 'ping', createdAt: 'T', status: 'queued' },
    'deviceCommands/b': { to: 'dev-b', command: 'ping', createdAt: 'T', status: 'queued' },
  });
  const seen: string[][] = [];
  const stop = docDeviceStore(db).watchDeviceCommands!('dev-b', (l) => seen.push(l.map((c) => c.uid)));
  stop();
  assert.deepEqual(seen, [['b']]);
});
