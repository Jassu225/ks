// lib/update.ts — `ks-flow update` (src/update.ts is the entry): get the new
// code, rebuild, restart the daemon and the board (README "Versioning").
//
//   1. New code.
//      - Installed (the plugin folder is under ~/.claude/plugins/cache/<marketplace>/):
//        `claude plugin marketplace update <marketplace>`, then
//        `claude plugin update ks-flow@<marketplace> --scope local` and the same
//        for ks, run in the KarmaSuite checkout (the plugins are installed per
//        project, at local scope).
//      - A clone: `git pull --ff-only`, only on `main` with no uncommitted
//        changes to tracked files. Anything else is refused with the reason: a
//        safety check, not a setting.
//   2. Rebuild: the new plugin folder's scripts/bootstrap.sh (the daemon copy).
//   3. Restart: `launchctl kickstart -k` the daemon, then the board if it runs.
// The daemon starts it detached (its own session), so the restart can't kill it.
// Every outcome is written to <dataDir>/update-state.json; the daemon reads it
// and sends the notice.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { cloneState, isMarketplaceCopy, pluginVersion, type Git } from './build-info.js';
import { compareSemver, type UpdateState } from './versioning.js';

export interface Step {
  label: string;
  cmd: string;
  args: string[];
  cwd: string;
  /** Run through the login shell (the user's PATH: where `claude` is). */
  login?: boolean;
}

export type UpdatePlan =
  | { ok: true; mode: 'clone'; repo: string; steps: Step[] }
  | { ok: true; mode: 'marketplace'; marketplace: string; steps: Step[] }
  | { ok: false; reason: string };

/** `<marketplace>` of an installed copy at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>. */
export function marketplaceOf(root: string, home = homedir()): string | null {
  const rel = relative(join(home, '.claude', 'plugins', 'cache'), root);
  const first = rel.split(sep)[0];
  return first && !first.startsWith('..') ? first : null;
}

/** What `ks-flow update` would do here, or why it can't. */
export function planUpdate(opts: {
  pluginRoot: string | null;
  projectPath: string | null;
  git: Git;
  home?: string;
}): UpdatePlan {
  const root = opts.pluginRoot;
  if (!root) return { ok: false, reason: "ks-flow's plugin folder is unknown" };
  if (isMarketplaceCopy(root, opts.home)) {
    const m = marketplaceOf(root, opts.home);
    if (!m) return { ok: false, reason: `can't tell the marketplace of ${root}` };
    const proj = opts.projectPath;
    if (!proj || !existsSync(proj)) {
      return { ok: false, reason: 'the KarmaSuite checkout (the project path) is unknown: the plugins are installed per project' };
    }
    const claude = (label: string, args: string[]): Step => ({ label, cmd: 'claude', args, cwd: proj, login: true });
    return {
      ok: true,
      mode: 'marketplace',
      marketplace: m,
      steps: [
        claude('marketplace', ['plugin', 'marketplace', 'update', m]),
        claude('ks-flow', ['plugin', 'update', `ks-flow@${m}`, '--scope', 'local']),
        claude('ks', ['plugin', 'update', `ks@${m}`, '--scope', 'local']),
      ],
    };
  }
  const c = cloneState(root, opts.git);
  if (!c) return { ok: false, reason: `${root} is neither an installed plugin nor a git clone` };
  if (c.branch !== 'main') {
    return { ok: false, reason: c.branch ? `the clone is on branch ${c.branch}, not main` : 'the clone is not on a branch (detached HEAD)' };
  }
  if (c.dirty) return { ok: false, reason: 'the clone has uncommitted changes' };
  return { ok: true, mode: 'clone', repo: c.top, steps: [{ label: 'git pull', cmd: 'git', args: ['pull', '--ff-only'], cwd: c.top }] };
}

/** The newest installed copy of a plugin in the marketplace cache (by its plugin.json version). */
export function newestCachedRoot(marketplace: string, plugin = 'ks-flow', home = homedir()): string | null {
  const dir = join(home, '.claude', 'plugins', 'cache', marketplace, plugin);
  let best: { root: string; v: string } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const root = join(dir, n);
    const v = pluginVersion(root);
    if (v && (!best || compareSemver(v, best.v) > 0)) best = { root, v };
  }
  return best?.root ?? null;
}

export interface RunResult {
  code: number;
  out: string;
}

export interface UpdateDeps {
  plan: UpdatePlan;
  fromVersion: string;
  by: 'auto' | 'manual';
  run: (s: Step) => RunResult;
  /** The plugin folder after step 1 (a clone: the same; installed: the new copy). */
  newRoot: (plan: Extract<UpdatePlan, { ok: true }>) => string | null;
  bootstrap: (root: string) => RunResult;
  restartDaemon: () => RunResult;
  /** Restart the board from the new folder when it runs (null: it doesn't). */
  restartBoard: (root: string) => RunResult | null;
  writeState: (s: UpdateState) => void;
  log: (m: string) => void;
  now?: () => number;
  pid?: number;
}

const tail = (s: string, n = 300): string => {
  const t = s.trim().split('\n').slice(-3).join(' | ');
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** Run the update; resolves to its final state (also written through `writeState`). */
export function runUpdate(d: UpdateDeps): UpdateState {
  const now = d.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const base: UpdateState = { state: 'running', startedAt: iso(), from: d.fromVersion, to: null, reason: null, pid: d.pid ?? process.pid, by: d.by };
  const finish = (s: Partial<UpdateState>): UpdateState => {
    const out: UpdateState = { ...base, ...s, endedAt: iso() };
    d.writeState(out);
    d.log(`update ${out.state}${out.to ? ` (${out.from} → ${out.to})` : ''}${out.reason ? `: ${out.reason}` : ''}`);
    return out;
  };
  const plan = d.plan;
  if (!plan.ok) return finish({ state: 'refused', reason: plan.reason });
  d.writeState(base);
  d.log(`update: ${plan.mode === 'clone' ? `git pull in ${plan.repo}` : `the ${plan.marketplace} marketplace`} (now ${d.fromVersion})`);

  for (const s of plan.steps) {
    d.log(`update: ${s.label}: ${s.cmd} ${s.args.join(' ')}`);
    const r = d.run(s);
    if (r.code !== 0) return finish({ state: 'failed', reason: `${s.label} failed (exit ${r.code})${r.out.trim() ? `: ${tail(r.out)}` : ''}` });
  }
  const root = d.newRoot(plan);
  if (!root) return finish({ state: 'failed', reason: "the updated plugin folder wasn't found" });
  const to = pluginVersion(root);
  d.log(`update: new code in ${root} (${to ?? 'version unknown'})`);

  const b = d.bootstrap(root);
  if (b.code !== 0) return finish({ state: 'failed', to, reason: `rebuild failed (exit ${b.code})${b.out.trim() ? `: ${tail(b.out)}` : ''}` });
  const r = d.restartDaemon();
  if (r.code !== 0) return finish({ state: 'failed', to, reason: `daemon restart failed (exit ${r.code})${r.out.trim() ? `: ${tail(r.out)}` : ''}` });
  const board = d.restartBoard(root);
  if (board && board.code !== 0) return finish({ state: 'failed', to, reason: `board restart failed (exit ${board.code})${board.out.trim() ? `: ${tail(board.out)}` : ''}` });
  return finish({ state: 'ok', to });
}
