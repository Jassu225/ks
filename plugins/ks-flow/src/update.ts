#!/usr/bin/env node
// update.ts — `ks-flow update`: bring this device's ks-flow up to the newest
// release (lib/update.ts has the steps and the clone's safety checks). The new
// code is fetched by ks's `ks-setup update` (every KS plugin, every worktree);
// an older ks without it → the old claude / git steps, run here.
//
//   ks-flow update             update now (by hand)
//   ks-flow update --dry-run   print what it would do, change nothing
//   ks-flow update --no-fetch  rebuild and restart only (ks-setup update runs this after it fetched)
//   (--auto: started by the daemon when the store holds a newer version)
//
// It logs to stdout (the daemon points that at <dataDir>/update.log), writes
// <dataDir>/update-state.json, and exits 0 when updated, 1 when refused or
// failed. One run at a time: a second one exits while the first one's pid lives;
// another update holding ks-setup's lock → "another update is running", exit 0,
// state "busy" (not a failure: the daemon retries later).
//
// The daemon copy is rebuilt while this runs (from the new plugin folder): it
// is loaded whole at start and imports nothing later, so that is safe.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, readProjectConf } from './lib/config.js';
import { ksPluginRoot, liveRoot, rootContext, type RootContext } from './lib/ksroot.js';
import { pluginVersion, readBuildFile, realGit } from './lib/build-info.js';
import { newestCachedRoot, planUpdate, runUpdate, type RunResult, type Step } from './lib/update.js';
import { readUpdateState, writeUpdateState } from './lib/versioning.js';

const LABEL = 'com.ksflow.ingester';
const LOGIN_PRELUDE =
  '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
  '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null;';

const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const by: 'auto' | 'manual' = has('--auto') ? 'auto' : 'manual';
const log = (m: string): void => console.log(`[${new Date().toISOString()}] [ks-flow update] ${m}`);

// The launchd PATH is bare: add the usual tool folders (lsof is in /usr/sbin).
const home = homedir();
process.env.PATH = [
  dirname(process.execPath),
  process.env.PATH ?? '',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(home, '.local', 'bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].filter(Boolean).join(':');

const DATA_DIR = dataDir();
process.env.KS_FLOW_DATA = DATA_DIR;
const daemonDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = readBuildFile(daemonDir);
const pluginRoot = build?.pluginRoot || ksPluginRoot('ks-flow');
const fromVersion = build?.version || (pluginRoot ? pluginVersion(pluginRoot) : null) || 'unknown';
const projectPath = readProjectConf()?.projectPath ?? null;

/** The resolver's context as seen from the KarmaSuite checkout (its installed entries win). */
function checkoutContext(): RootContext {
  const ctx = rootContext();
  return {
    ...ctx,
    cwd: projectPath && existsSync(projectPath) ? projectPath : ctx.cwd,
    projectPath: process.env.KS_PROJECT_ROOT_PATH || projectPath || undefined,
  };
}

/** ks's scripts/ks-setup, or null (ks not found, or no ks-setup there). */
function findKsSetup(): string | null {
  const ks = liveRoot('ks', checkoutContext()) ?? ksPluginRoot('ks');
  const bin = ks ? join(ks, 'scripts', 'ks-setup') : null;
  return bin && existsSync(bin) ? bin : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(s: Step): RunResult {
  // ks-setup updates every plugin in every worktree: give it longer.
  const timeout = (s.ksSetup ? 30 : 10) * 60_000;
  const r = s.login
    ? spawnSync('/bin/zsh', ['-c', `${LOGIN_PRELUDE} exec "$0" "$@"`, s.cmd, ...s.args], { cwd: s.cwd, encoding: 'utf8', timeout })
    : spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: 'utf8', timeout });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`;
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return { code: r.status ?? 1, out, stdout: r.stdout ?? '' };
}

/** The launchd job's CLAUDE_PLUGIN_OPTION_* settings, so bootstrap renders the same plist from a plain shell. */
function plistOptions(): Record<string, string> {
  try {
    const plist = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const json = execFileSync('plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(env).filter(([k, v]) => k.startsWith('CLAUDE_PLUGIN_OPTION_') && typeof v === 'string') as [string, string][],
    );
  } catch {
    return {};
  }
}

function newRoot(plan: Parameters<Parameters<typeof runUpdate>[0]['newRoot']>[0]): string | null {
  if (plan.mode === 'clone') return pluginRoot;
  // The installed copy the KarmaSuite checkout now loads (read fresh from Claude
  // Code's records, never spawning claude), else the newest in the cache.
  return liveRoot('ks-flow', checkoutContext()) ?? newestCachedRoot(plan.marketplace, 'ks-flow', home);
}

function bootstrap(root: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...plistOptions(), ...process.env, KS_FLOW_NO_RESTART: '1' };
  if (projectPath && !env.CLAUDE_PLUGIN_OPTION_project_path) env.CLAUDE_PLUGIN_OPTION_project_path = projectPath;
  delete env.KS_FLOW_HOOK;
  const r = spawnSync(join(root, 'scripts', 'bootstrap.sh'), [], { env, encoding: 'utf8', timeout: 20 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`;
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return { code: r.status ?? 1, out };
}

function restartDaemon(): RunResult {
  const uid = process.getuid?.() ?? 0;
  return run({ label: 'restart daemon', cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${LABEL}`], cwd: home });
}

function restartBoard(root: string): RunResult | null {
  const port = process.env.CLAUDE_PLUGIN_OPTION_board_port || plistOptions().CLAUDE_PLUGIN_OPTION_board_port || '4317';
  const up = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  if (!(up.stdout ?? '').trim()) {
    log(`board not running on port ${port}: not started`);
    return null;
  }
  const bin = join(root, 'bin', 'ks-flow');
  const closed = run({ label: 'close board', cmd: bin, args: ['close'], cwd: home });
  if (closed.code !== 0) return closed;
  const env = { ...process.env, KS_FLOW_NO_BROWSER: '1' };
  const r = spawnSync(bin, ['open'], { env, encoding: 'utf8', timeout: 20 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return { code: r.status ?? 1, out };
}

function main(): number {
  const noFetch = has('--no-fetch');
  const ksSetup = noFetch ? null : findKsSetup();
  const plan = planUpdate({ pluginRoot, projectPath, git: realGit, home, ksSetup, auto: by === 'auto', noFetch });
  if (has('--dry-run')) {
    console.log(JSON.stringify({ dataDir: DATA_DIR, pluginRoot, fromVersion, projectPath, ksSetup, noFetch, plan }, null, 2));
    return plan.ok ? 0 : 1;
  }
  const last = readUpdateState(DATA_DIR);
  if (last?.state === 'running' && last.pid && last.pid !== process.pid && alive(last.pid)) {
    log(`another update is running (pid ${last.pid})`);
    return 1;
  }
  const out = runUpdate({
    plan,
    fromVersion,
    by,
    run,
    newRoot,
    bootstrap,
    restartDaemon,
    restartBoard,
    writeState: (s) => writeUpdateState(DATA_DIR, s),
    log,
  });
  if (out.state === 'busy') return 0; // logged by runUpdate: "another update is running"
  if (out.state !== 'ok') console.error(`ks-flow update ${out.state}: ${out.reason ?? ''}`);
  return out.state === 'ok' ? 0 : 1;
}

process.exit(main());
