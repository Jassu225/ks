// lib/ksroot.ts — find a KS plugin's folder from the daemon (launchd: no
// plugin env, bare PATH), in the same order as the ks plugin's lib/ks-root.sh
// (ksr_live_root). The folder is derived from Claude Code's own records each
// time, never from a remembered versioned cache folder (those go stale on update):
//   1. KS_ROOT_<NAME> (upper-cased, - → _)
//   2. a directory marketplace: known_marketplaces.json's karmasuite entry with
//      source.source == "directory" → <installLocation>/plugins/<name> (its
//      plugin.json must name <name>); Claude Code reads it in place, so stale
//      cache entries in installed_plugins.json don't count
//   3. the chosen installed_plugins.json (v2) entry of <name>@karmasuite, skipping
//      entries whose installPath is gone: the local/project entry whose
//      projectPath contains cwd (longest), then the KS checkout's entry
//      (projectPath == KS_PROJECT_ROOT_PATH, env or ${KS_CONFIG_DIR}/ks.env),
//      then a user/managed entry, then the highest version
//   4. the registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json, entries with
//      mode "local" (a clone) only
//   5. the sibling folder next to this plugin (a clone: plugins/<name>; its
//      plugin.json must name <name>)
//   6. (ksPluginRoot only) `claude plugin list --json` through the login shell
// Steps 1–5 are liveRoot, a pure function of its context (and fs reader);
// web/lib/ksroot.ts carries a twin (ksroot.test.ts checks they agree).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KS_MARKETPLACE = 'karmasuite';

/** File access liveRoot needs; tests pass an in-memory one. */
export interface RootFs {
  /** The file's text, or null when it can't be read. */
  read(path: string): string | null;
  isDir(path: string): boolean;
  /** The path with symlinks resolved, or null when it doesn't exist (optional). */
  realpath?(path: string): string | null;
}

export const realFs: RootFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

export interface RootContext {
  home: string;
  /** The KS config folder: ${KS_CONFIG_DIR:-~/.config/ks} (registry, ks.env). */
  configDir: string;
  cwd: string;
  /** The KS checkout (KS_PROJECT_ROOT_PATH); undefined → read <configDir>/ks.env. */
  projectPath?: string | null;
  /** Claude Code's config folder: ${CLAUDE_CONFIG_DIR:-<home>/.claude}. */
  claudeDir?: string;
  /** The folder holding this plugin and its siblings (a clone's plugins/). */
  pluginsDir?: string | null;
  /** Where KS_ROOT_<NAME> is read; default none. */
  env?: Record<string, string | undefined>;
  fs?: RootFs;
}

interface InstalledEntry {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  version?: string;
  lastUpdated?: string;
}

function readJson<T>(fs: RootFs, path: string): T | null {
  const text = fs.read(path);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** A path for comparing: trailing / stripped and, where it exists, symlinks resolved
 *  (process.cwd() is the real path while bash's $PWD is as typed, e.g. /tmp vs /private/tmp). */
function norm(fs: RootFs, p: string): string {
  const t = trimSlash(p);
  return (fs.realpath ? fs.realpath(t) : null) ?? t;
}

function declaresName(fs: RootFs, dir: string, name: string): boolean {
  return readJson<{ name?: string }>(fs, join(dir, '.claude-plugin', 'plugin.json'))?.name === name;
}

/** KS_PROJECT_ROOT_PATH from a ks.env text (last assignment wins, quotes stripped, ~ expanded). */
export function projectPathFromEnvFile(text: string | null, home: string): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?KS_PROJECT_ROOT_PATH\s*=\s*(.*?)\s*$/.exec(line);
    if (m) found = m[1].replace(/^["']|["']$/g, '');
  }
  if (!found) return null;
  return found.startsWith('~') ? home + found.slice(1) : found;
}

/** Compare the first three numeric parts of two versions (1.0.10 > 1.0.9; a non-number counts as 0), as ks-root.sh does. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => [...v.split(/[.+-]/).map((x) => Number(x) || 0), 0, 0, 0].slice(0, 3);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The newest of some entries: highest version; a tie keeps file order (as ks-root.sh's sort_by). */
function newest(entries: InstalledEntry[]): InstalledEntry | undefined {
  return [...entries].sort((a, b) => compareVersions(String(b.version ?? '0'), String(a.version ?? '0')))[0];
}

/** Pick the installed entry a session in `cwd` loads (see the header, step 3). */
export function chooseInstalled(
  entries: InstalledEntry[],
  cwd: string,
  projectPath: string | null,
  fs: RootFs = realFs,
): InstalledEntry | null {
  const live = entries.filter((e) => !!e.installPath && fs.isDir(e.installPath));
  if (live.length === 0) return null;
  const here = norm(fs, cwd);
  const scoped = live.filter((e) => (e.scope === 'local' || e.scope === 'project') && e.projectPath);
  const containing = scoped.filter((e) => {
    const p = norm(fs, e.projectPath!);
    return here === p || here.startsWith(p === '/' ? '/' : `${p}/`);
  });
  if (containing.length) {
    const longest = Math.max(...containing.map((e) => norm(fs, e.projectPath!).length));
    return newest(containing.filter((e) => norm(fs, e.projectPath!).length === longest)) ?? null;
  }
  if (projectPath) {
    const checkout = norm(fs, projectPath);
    const mine = live.filter((e) => !!e.projectPath && norm(fs, e.projectPath) === checkout);
    if (mine.length) return newest(mine) ?? null;
  }
  const wide = live.filter((e) => e.scope === 'user' || e.scope === 'managed');
  if (wide.length) return newest(wide) ?? null;
  return newest(live) ?? null;
}

/** A KS plugin's current folder (steps 1–5 of the header), or null. Never spawns. */
export function liveRoot(name: string, ctx: RootContext): string | null {
  const fs = ctx.fs ?? realFs;
  const claudeDir = ctx.claudeDir || join(ctx.home, '.claude');

  // 1. KS_ROOT_<NAME>
  const env = ctx.env?.[`KS_ROOT_${name.toUpperCase().replace(/-/g, '_')}`];
  if (env && fs.isDir(env)) return env;

  // 2. a directory marketplace, read in place
  const markets = readJson<Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>>(
    fs,
    join(claudeDir, 'plugins', 'known_marketplaces.json'),
  );
  const market = markets?.[KS_MARKETPLACE];
  if (market?.source?.source === 'directory') {
    const location = market.installLocation || market.source.path;
    if (location) {
      const dir = join(location, 'plugins', name);
      if (fs.isDir(dir) && declaresName(fs, dir, name)) return dir;
    }
  }

  // 3. the installed entry this cwd / the KS checkout loads
  const installed = readJson<{ plugins?: Record<string, InstalledEntry[] | InstalledEntry> }>(
    fs,
    join(claudeDir, 'plugins', 'installed_plugins.json'),
  );
  const listed = installed?.plugins?.[`${name}@${KS_MARKETPLACE}`];
  const entries = (Array.isArray(listed) ? listed : listed ? [listed] : []).filter(
    (e): e is InstalledEntry => !!e && typeof e === 'object' && typeof e.installPath === 'string',
  );
  if (entries.length) {
    const projectPath =
      ctx.projectPath !== undefined
        ? ctx.projectPath
        : projectPathFromEnvFile(fs.read(join(ctx.configDir, 'ks.env')), ctx.home);
    const chosen = chooseInstalled(entries, ctx.cwd, projectPath || null, fs);
    if (chosen?.installPath) return chosen.installPath;
  }

  // 4. the registry, clones only
  const reg = readJson<Record<string, { root?: string; mode?: string }>>(fs, join(ctx.configDir, 'plugins.json'));
  const rec = reg?.[name];
  if (rec?.mode === 'local' && rec.root && fs.isDir(rec.root)) return rec.root;

  // 5. the sibling folder
  if (ctx.pluginsDir) {
    const dir = join(ctx.pluginsDir, name);
    if (fs.isDir(dir) && declaresName(fs, dir, name)) return dir;
  }
  return null;
}

/** The folder holding ks-flow and its siblings: walk up from this file to ks-flow's plugin.json. */
function ownPluginsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (declaresName(realFs, dir, 'ks-flow')) return dirname(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** liveRoot's context from this process (env, cwd, this file's plugin folder). */
export function rootContext(): RootContext {
  const home = homedir();
  return {
    home,
    configDir: process.env.KS_CONFIG_DIR || join(home, '.config', 'ks'),
    cwd: process.cwd(),
    projectPath: process.env.KS_PROJECT_ROOT_PATH || undefined,
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    pluginsDir: ownPluginsDir(),
    env: process.env,
  };
}

export function registryPath(): string {
  return join(process.env.KS_CONFIG_DIR || join(homedir(), '.config', 'ks'), 'plugins.json');
}

/** The registry's root for <name>, clones (mode "local") only. */
export function fromRegistry(name: string, file = registryPath()): string | null {
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { root?: string; mode?: string }>;
    const rec = reg[name];
    return rec?.mode === 'local' && rec.root && existsSync(rec.root) ? rec.root : null;
  } catch {
    return null;
  }
}

interface ListedPlugin {
  id?: string;
  readFromFolder?: string;
  installPath?: string;
  lastUpdated?: string;
}

/** The newest `<name>@<any marketplace>` in `claude plugin list --json` output. */
export function fromPluginList(name: string, json: string): string | null {
  try {
    const list = JSON.parse(json) as ListedPlugin[];
    const hits = list
      .filter((p) => (p.id ?? '').startsWith(`${name}@`))
      .sort((a, b) => (a.lastUpdated ?? '').localeCompare(b.lastUpdated ?? ''));
    const p = hits[hits.length - 1];
    const root = p?.readFromFolder || p?.installPath;
    return root && existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const LOGIN_PRELUDE =
  '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
  '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null;';

export function ksPluginRoot(name: string): string | null {
  const live = liveRoot(name, rootContext());
  if (live) return live;
  try {
    const out = execFileSync('/bin/zsh', ['-c', `${LOGIN_PRELUDE} claude plugin list --json`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    return fromPluginList(name, out);
  } catch {
    return null;
  }
}
