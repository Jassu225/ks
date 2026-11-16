// lib/update.ts — `ks-flow update` (src/update.ts is the entry): get the new
// code, rebuild, restart the daemon and the board (README "Versioning").
//
//   1. New code: ks's `ks-setup update --no-restart --json [--auto]` fetches it
//      for every KS plugin (marketplace: every project entry, worktrees too; a
//      clone: `git pull --ff-only`). ks-flow still refuses first, with the same
//      reasons as before (a safety check, not a setting):
//      - installed (the plugin folder is under ~/.claude/plugins/cache/<marketplace>/):
//        the KarmaSuite checkout (the project path) must be known;
//      - a clone: only on `main` with no uncommitted changes to tracked files.
//      ks-setup's exit 2 (an older ks without `update`) → the old steps, run here:
//      installed: `claude plugin marketplace update <marketplace>`, then
//      `claude plugin update ks-flow@<marketplace> --scope local` and the same for
//      ks, in the KarmaSuite checkout; a clone: `git pull --ff-only`. No ks-setup
//      found → the old steps too. Exit 3 (another update holds ks-setup's lock) →
//      "busy": nothing more is done; the state says so (not a failure).
//      --no-fetch: no step 1 (ks-setup runs `ks-flow update --no-fetch` itself
//      after it fetched; it never runs ks-flow otherwise, and ks-flow never asks
//      ks-setup to restart, so neither calls the other back).
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
  /** `ks-setup update`: exit 2 → the plan's fallback, exit 3 → busy, JSON on stdout. */
  ksSetup?: boolean;
}

/** Steps 1 of the plan: `steps` run in order; `fallback` replaces a ks-setup step that exits 2. */
interface Fetch {
  steps: Step[];
  /** The old steps, for an older ks whose ks-setup has no `update` (exit 2). */
  fallback?: Step[];
}

export type UpdatePlan =
  | ({ ok: true; mode: 'clone'; repo: string } & Fetch)
  | ({ ok: true; mode: 'marketplace'; marketplace: string } & Fetch)
  | { ok: false; reason: string };

/** The ks-setup step: fetch every KS plugin, never restart ks-flow (this run does). */
export function ksSetupStep(ksSetup: string, cwd: string, auto: boolean): Step {
  return {
    label: 'ks-setup update',
    cmd: ksSetup,
    args: ['update', '--no-restart', '--json', ...(auto ? ['--auto'] : [])],
    cwd,
    login: true,
    ksSetup: true,
  };
}

/** Step 1 from the old steps: ks-setup in front of them when it is known, else the old steps alone. */
function fetchSteps(old: Step[], ksSetup: string | null | undefined, cwd: string, auto: boolean): Fetch {
  return ksSetup ? { steps: [ksSetupStep(ksSetup, cwd, auto)], fallback: old } : { steps: old };
}

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
  /** ks's scripts/ks-setup (null/absent: not found → the old steps). */
  ksSetup?: string | null;
  /** Pass --auto to ks-setup (the daemon started this run). */
  auto?: boolean;
  /** No fetch: rebuild and restart only (ks-setup already fetched). */
  noFetch?: boolean;
}): UpdatePlan {
  const root = opts.pluginRoot;
  if (!root) return { ok: false, reason: "ks-flow's plugin folder is unknown" };
  const auto = !!opts.auto;
  if (isMarketplaceCopy(root, opts.home)) {
    const m = marketplaceOf(root, opts.home);
    if (!m) return { ok: false, reason: `can't tell the marketplace of ${root}` };
    if (opts.noFetch) return { ok: true, mode: 'marketplace', marketplace: m, steps: [] };
    const proj = opts.projectPath;
    if (!proj || !existsSync(proj)) {
      return { ok: false, reason: 'the KarmaSuite checkout (the project path) is unknown: the plugins are installed per project' };
    }
    const claude = (label: string, args: string[]): Step => ({ label, cmd: 'claude', args, cwd: proj, login: true });
    return {
      ok: true,
      mode: 'marketplace',
      marketplace: m,
      ...fetchSteps(
        [
          claude('marketplace', ['plugin', 'marketplace', 'update', m]),
          claude('ks-flow', ['plugin', 'update', `ks-flow@${m}`, '--scope', 'local']),
          claude('ks', ['plugin', 'update', `ks@${m}`, '--scope', 'local']),
        ],
        opts.ksSetup,
        proj,
        auto,
      ),
    };
  }
  const c = cloneState(root, opts.git);
  if (!c) return { ok: false, reason: `${root} is neither an installed plugin nor a git clone` };
  // Nothing is pulled: the branch and the tree don't matter (only a fetch could lose work).
  if (opts.noFetch) return { ok: true, mode: 'clone', repo: c.top, steps: [] };
  if (c.branch !== 'main') {
    return { ok: false, reason: c.branch ? `the clone is on branch ${c.branch}, not main` : 'the clone is not on a branch (detached HEAD)' };
  }
  if (c.dirty) return { ok: false, reason: 'the clone has uncommitted changes' };
  const pull: Step = { label: 'git pull', cmd: 'git', args: ['pull', '--ff-only'], cwd: c.top };
  return { ok: true, mode: 'clone', repo: c.top, ...fetchSteps([pull], opts.ksSetup, c.top, auto) };
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
  /** stdout and stderr together (for the reason). */
  out: string;
  /** stdout alone (ks-setup's JSON line); absent: use `out`. */
  stdout?: string;
}

/** What ks-flow reads of `ks-setup update --json`'s one stdout line. */
export interface KsSetupResult {
  state: 'updated' | 'current' | 'available' | 'refused' | 'failed' | 'busy' | string;
  mode?: string | null;
  plugins?: { plugin?: string; from?: string | null; to?: string | null }[];
  reason?: string | null;
  log?: string | null;
}

/** The last stdout line that parses as ks-setup's JSON object, or null. */
export function parseKsSetup(stdout: string): KsSetupResult | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]) as unknown;
      if (j && typeof j === 'object' && typeof (j as KsSetupResult).state === 'string') return j as KsSetupResult;
    } catch {
      // not the JSON line
    }
  }
  return null;
}

/** "ks 1.0.6 → 1.1.0, ks-flow 0.2.2 → 0.3.0", or "nothing new". */
export function changedPlugins(r: KsSetupResult): string {
  const moved = (r.plugins ?? []).filter((p) => p.plugin && p.from !== p.to);
  return moved.length ? moved.map((p) => `${p.plugin} ${p.from ?? '?'} → ${p.to ?? '?'}`).join(', ') : 'nothing new';
}

/** Every outcome is an update-state.json record ("busy" too: see runUpdate). */
export type UpdateOutcome = UpdateState;

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
export function runUpdate(d: UpdateDeps): UpdateOutcome {
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
  const where = plan.mode === 'clone' ? `the clone ${plan.repo}` : `the ${plan.marketplace} marketplace`;
  d.log(`update: ${plan.steps.length ? where : `no fetch, rebuild from ${where}`} (running ${d.fromVersion})`);

  const failedStep = (s: Step, r: RunResult): Partial<UpdateState> => ({
    state: 'failed',
    reason: `${s.label} failed (exit ${r.code})${r.out.trim() ? `: ${tail(r.out)}` : ''}`,
  });
  /** Run steps in order; the first failure's state, or null when all passed. */
  const runAll = (steps: Step[]): Partial<UpdateState> | null => {
    for (const s of steps) {
      d.log(`update: ${s.label}: ${s.cmd} ${s.args.join(' ')}`);
      const r = d.run(s);
      if (r.code !== 0) return failedStep(s, r);
    }
    return null;
  };

  for (const s of plan.steps) {
    if (!s.ksSetup) {
      const bad = runAll([s]);
      if (bad) return finish(bad);
      continue;
    }
    d.log(`update: ${s.label}: ${s.cmd} ${s.args.join(' ')}`);
    const r = d.run(s);
    if (r.code === 2) {
      d.log('update: this ks-setup has no `update` (an older ks): the old steps');
      const bad = runAll(plan.fallback ?? []);
      if (bad) return finish(bad);
      continue;
    }
    const j = parseKsSetup(r.stdout ?? r.out);
    if (r.code === 3 || j?.state === 'busy') {
      const why = 'another update is running';
      d.log(`update: ${why}${j?.reason ? ` (${j.reason})` : ''}: nothing done`);
      // Recorded, so the "running" record above (a pid about to exit) doesn't
      // stay behind: the daemon reads "busy" as being updated, retries in ten
      // minutes, and never says "update by hand" meanwhile.
      return finish({ state: 'busy', reason: why });
    }
    if (r.code !== 0 || !j || j.state === 'refused' || j.state === 'failed') {
      if (j?.reason) {
        const log = j.log ? ` (log ${j.log})` : '';
        return finish({ state: j.state === 'refused' ? 'refused' : 'failed', reason: `ks-setup update ${j.state}: ${j.reason}${log}` });
      }
      if (r.code !== 0) return finish(failedStep(s, r));
      return finish({ state: 'failed', reason: `${s.label} gave no result (exit 0)${r.out.trim() ? `: ${tail(r.out)}` : ''}` });
    }
    d.log(`update: ks-setup update ${j.state}: ${changedPlugins(j)}${j.log ? ` (log ${j.log})` : ''}`);
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
