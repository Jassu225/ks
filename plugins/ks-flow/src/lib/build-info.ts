// lib/build-info.ts — what this ks-flow build is: its release (ks-flow's
// plugin.json version, not the daemon's package.json), where its plugin folder
// is, how it was installed, and whether it is a dev build.
//
// The daemon runs from a copy (<dataDir>/daemon, built by scripts/bootstrap.sh),
// so bootstrap leaves <dataDir>/daemon/build.json {version, pluginRoot} beside
// dist/. Without it (an older bootstrap), the plugin folder comes from the KS
// registry and the version from its plugin.json.
//
// Install mode:
//   marketplace  the folder is under ~/.claude/plugins/cache/ (an installed copy)
//   clone        the folder is in a git work tree (a clone, e.g. a directory marketplace)
//   unknown      neither: it can't be updated by `ks-flow update`
// A clone not on `main`, or with uncommitted changes to tracked files, is a dev
// build: it never raises meta/settings' version and never auto-updates.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export const BUILD_FILE = 'build.json';

/** Runs git in a folder and returns its stdout (trimmed); throws when git fails. */
export type Git = (args: string[], cwd: string) => string;

export const realGit: Git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();

export type InstallMode = 'marketplace' | 'clone' | 'unknown';

export interface CloneState {
  /** The work tree's top folder. */
  top: string;
  /** The checked-out branch (null when detached). */
  branch: string | null;
  /** Uncommitted changes to tracked files. */
  dirty: boolean;
}

/** The git state of the folder, or null when it is not in a work tree. */
export function cloneState(root: string, git: Git): CloneState | null {
  let top: string;
  try {
    top = git(['rev-parse', '--show-toplevel'], root);
  } catch {
    return null;
  }
  if (!top) return null;
  let branch: string | null = null;
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], top) || null;
  } catch {
    branch = null;
  }
  let dirty = true;
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=no'], top) !== '';
  } catch {
    dirty = true; // can't tell: not clean
  }
  return { top, branch, dirty };
}

/** Why a clone is a dev build (null: a release, on main with a clean tree). */
export function devReason(c: CloneState): string | null {
  if (c.branch !== 'main') return c.branch ? `on branch ${c.branch}, not main` : 'not on a branch (detached HEAD)';
  if (c.dirty) return 'uncommitted changes';
  return null;
}

export function isMarketplaceCopy(root: string, home = homedir()): boolean {
  return root.startsWith(join(home, '.claude', 'plugins', 'cache') + sep);
}

export function installMode(root: string | null, clone: CloneState | null, home = homedir()): InstallMode {
  if (root && isMarketplaceCopy(root, home)) return 'marketplace';
  if (clone) return 'clone';
  return 'unknown';
}

/** ks-flow's release from its plugin folder (`.claude-plugin/plugin.json`). */
export function pluginVersion(root: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export interface BuildFile {
  version?: string;
  pluginRoot?: string;
  builtAt?: string;
}

export function readBuildFile(daemonDir: string): BuildFile | null {
  try {
    return JSON.parse(readFileSync(join(daemonDir, BUILD_FILE), 'utf8')) as BuildFile;
  } catch {
    return null;
  }
}

export interface BuildInfo {
  version: string;
  pluginRoot: string | null;
  mode: InstallMode;
  dev: boolean;
  devReason: string | null;
}

/**
 * This build. `daemonDir` holds build.json (the daemon's copy, beside dist/);
 * `findRoot` is the fallback for the plugin folder; `fallbackVersion` the last
 * resort (the daemon's package.json).
 */
export function detectBuild(opts: {
  daemonDir: string;
  findRoot: () => string | null;
  fallbackVersion: string;
  git?: Git;
  home?: string;
}): BuildInfo {
  const file = readBuildFile(opts.daemonDir);
  let root = file?.pluginRoot && existsSync(file.pluginRoot) ? file.pluginRoot : null;
  if (!root) root = opts.findRoot();
  const version = file?.version || (root ? pluginVersion(root) : null) || opts.fallbackVersion;
  const clone = root && !isMarketplaceCopy(root, opts.home) ? cloneState(root, opts.git ?? realGit) : null;
  const mode = installMode(root, clone, opts.home);
  const why = clone ? devReason(clone) : null;
  return { version, pluginRoot: root, mode, dev: !!why, devReason: why };
}
