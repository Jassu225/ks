#!/usr/bin/env node
// inbox-check.ts — `ks-flow inbox-check [--dry-run]`: is this Mac's Plannotator
// Inbox up, published on the tailnet and linked, and if not, put it right.
//
// A stopgap until Plannotator reclaims its own Tailscale mappings after a
// reboot (see lib/inbox-check.ts). The person runs it (it restarts the Inbox,
// which Plannotator leaves to the person, and removes Tailscale mappings):
//   1. plannotator installed           (else: how to install it; stop)
//   2. Tailscale installed and running (else: open it and log in; stop)
//   3. the Inbox running               (else: start it, published)
//   4. leftover serve mappings         (on the Inbox's port or a link-door port,
//                                       pointing at a loopback port nothing
//                                       listens on: removed)
//   5. published (a tailnet address)   (else: restart it, published)
//   6. linked machines online          (reported; another Mac asleep is not fixed here)
// Steps 3–5 run up to twice: after a reboot it can take two rounds. --dry-run
// only reports. Exit 0 healthy, 1 not, 2 usage.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { leftoverRoutes, linkOnline, linkRows, serveRoutes, type ServeRoute } from './lib/inbox-check.js';

const args = process.argv.slice(2);
if (args.some((a) => a !== '--dry-run')) {
  console.error('usage: ks-flow inbox-check [--dry-run]');
  process.exit(2);
}
const dryRun = args.includes('--dry-run');

const say = (mark: 'ok' | 'fix' | 'warn' | 'fail' | '..', text: string): void => {
  console.log(`  ${mark.padEnd(4)} ${text}`);
};

function which(name: string, fallbacks: string[]): string | null {
  try {
    const p = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (p) return p;
  } catch {
    /* not on PATH */
  }
  return fallbacks.find((f) => existsSync(f)) ?? null;
}

function run(bin: string, argv: string[], timeoutMs = 30_000): { code: number; out: string } {
  try {
    const out = execFileSync(bin, argv, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof err.status === 'number' ? err.status : 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? '') };
  }
}

/** Does something answer on 127.0.0.1:<port>? */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

interface InboxStatus {
  running: boolean;
  port: number | null;
  tailnetUrl: string | null;
  version: string | null;
}

function inboxStatus(pl: string): InboxStatus {
  const r = run(pl, ['inbox', 'status', '--json'], 15_000);
  try {
    const j = JSON.parse(r.out) as { running?: boolean; port?: number; tailnet_url?: string | null; version?: string };
    return { running: j.running === true, port: typeof j.port === 'number' ? j.port : null, tailnetUrl: j.tailnet_url ?? null, version: j.version ?? null };
  } catch {
    return { running: false, port: null, tailnetUrl: null, version: null };
  }
}

async function leftovers(ts: string, inboxPort: number | null): Promise<ServeRoute[] | null> {
  const r = run(ts, ['serve', 'status', '--json'], 15_000);
  const routes = r.code === 0 ? serveRoutes(r.out) : undefined;
  if (!routes) return null;
  const alive = new Map<number, boolean>();
  for (const route of routes) {
    const m = /:(\d+)\/?$/.exec(route.target);
    if (m) alive.set(Number(m[1]), await listening(Number(m[1])));
  }
  return leftoverRoutes(routes, inboxPort, (p) => alive.get(p) ?? true);
}

async function main(): Promise<void> {
  console.log(`Plannotator Inbox on this Mac${dryRun ? ' (dry run: nothing is changed)' : ''}`);
  const pl = which('plannotator', [join(homedir(), '.local', 'bin', 'plannotator')]);
  if (!pl) {
    say('fail', 'plannotator is not installed: curl -fsSL https://plannotator.ai/install.sh | bash');
    process.exit(1);
  }
  say('ok', `plannotator ${run(pl, ['--version'], 10_000).out.trim().replace(/^plannotator\s*/, '')}`);

  const ts = which('tailscale', ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  if (!ts) {
    say('fail', 'Tailscale is not installed: Mac App Store, tailscale.com/download, or brew install --cask tailscale');
    process.exit(1);
  }
  let state = '';
  try {
    state = (JSON.parse(run(ts, ['status', '--json'], 15_000).out) as { BackendState?: string }).BackendState ?? '';
  } catch {
    /* no answer */
  }
  if (state !== 'Running') {
    say('fail', `Tailscale is not running (${state || 'no answer'}): open Tailscale and log in, then run this again`);
    process.exit(1);
  }
  say('ok', 'Tailscale running');

  for (let round = 1; round <= 2; round++) {
    let st = inboxStatus(pl);
    let changed = false;
    if (!st.running) {
      if (dryRun) say('warn', 'the Inbox is not running');
      else {
        say('fix', 'the Inbox is not running: starting it, published on the tailnet');
        run(pl, ['inbox', '--background', '--tailscale'], 60_000);
        changed = true;
        st = inboxStatus(pl);
      }
    }
    const stale = await leftovers(ts, st.port);
    if (stale === null) say('warn', 'could not read `tailscale serve status`');
    for (const r of stale ?? []) {
      if (dryRun) say('warn', `leftover Tailscale mapping: https port ${r.port} → ${r.target} (nothing listens there)`);
      else {
        say('fix', `removing a leftover Tailscale mapping: https port ${r.port} → ${r.target} (nothing listens there)`);
        const off = run(ts, ['serve', `--https=${r.port}`, 'off'], 15_000);
        if (off.code !== 0) say('fail', `tailscale serve --https=${r.port} off failed: ${off.out.trim().split('\n').pop()}`);
        changed = true;
      }
    }
    const selfRow = linkRows(run(pl, ['inbox', 'link', '--list'], 15_000).out).find((r) => r.self);
    const doorComplaint = !!selfRow?.note && /mapping/i.test(selfRow.note);
    if (doorComplaint) say(dryRun ? 'warn' : 'fix', `the link door: ${selfRow!.note}`);
    if (!dryRun && (changed || !st.tailnetUrl || doorComplaint)) {
      say('fix', `restarting the Inbox, published on the tailnet${round > 1 ? ' (second round)' : ''}`);
      const r = run(pl, ['inbox', 'restart', '--tailscale'], 60_000);
      const line = r.out.split('\n').find((l) => /tailnet|Not published/i.test(l));
      if (line) say('..', line.trim());
      await new Promise((res) => setTimeout(res, 2500));
      continue; // check again
    }
    break;
  }

  // The result.
  const st = inboxStatus(pl);
  let healthy = true;
  if (st.running) say('ok', `the Inbox runs (${st.version ?? '?'}) on port ${st.port ?? '?'}`);
  else {
    say('fail', 'the Inbox is not running');
    healthy = false;
  }
  if (st.tailnetUrl) say('ok', `published on the tailnet: ${st.tailnetUrl}`);
  else {
    say('fail', 'not published on the tailnet: run `plannotator inbox` and read what it says');
    healthy = false;
  }
  const stale = await leftovers(ts, st.port);
  if (stale && stale.length) {
    say('fail', `leftover Tailscale mappings remain: ${stale.map((r) => `${r.port} → ${r.target}`).join(', ')}`);
    healthy = false;
  }
  const rows = linkRows(run(pl, ['inbox', 'link', '--list'], 15_000).out);
  const others = rows.filter((r) => !r.self);
  if (others.length === 0) say('warn', 'not linked with another Mac (ks-setup doctor: plannotator:linked)');
  for (const r of others) {
    if (linkOnline(r)) say('ok', `linked: ${r.name} (${r.state})`);
    else say('warn', `linked: ${r.name} is ${r.state || 'not answering'} (asleep, offline, or its Inbox needs this check too)`);
  }
  const selfRow = rows.find((r) => r.self);
  if (selfRow?.note) {
    say('fail', `this Mac's link door: ${selfRow.note}`);
    healthy = false;
  }
  console.log(healthy ? 'All good.' : dryRun ? 'Problems found: run `ks-flow inbox-check` (without --dry-run) to fix them.' : 'Not fixed: see the lines above.');
  process.exit(healthy ? 0 : 1);
}

main().catch((e) => {
  console.error(`ks-flow inbox-check: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
