// lib/ksroot.ts — SERVER-only: the ks-flow plugin's own folder for the board's
// API routes. KS_FLOW_PLUGIN_ROOT (exported by `ks-flow open`) unless that
// folder is gone (an installed plugin's version folder is replaced on update),
// then liveRoot('ks-flow'): the board's twin of src/lib/ksroot.ts's liveRoot
// (web can't import src/; src/lib/ksroot.test.ts checks the two agree). Keep
// both in step with the ks plugin's lib/ks-root.sh (ksr_live_root):
//   1. KS_ROOT_<NAME>  2. a directory karmasuite marketplace's plugins/<name>
//   3. the chosen installed_plugins.json entry (cwd's, the KS checkout's,
//      user/managed, highest version; installPath must exist)
//   4. the registry, mode "local" only  5. the sibling folder
import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandHome } from './ksconfig';

export const KS_MARKETPLACE = 'karmasuite';

export interface RootFs {
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
  configDir: string;
  cwd: string;
  projectPath?: string | null;
  claudeDir?: string;
  pluginsDir?: string | null;
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

export function projectPathFromEnvFile(text: string | null, home: string): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?KS_PROJECT_ROOT_PATH\s*=\s*(.*?)\s*$/.exec(line);
    if (m) found = m[1].replace(/^["']|["']$/g, '');
  }
  if (!found) return null;
  return expandHome(found, home);
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => [...v.split(/[.+-]/).map((x) => Number(x) || 0), 0, 0, 0].slice(0, 3);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function newest(entries: InstalledEntry[]): InstalledEntry | undefined {
  return [...entries].sort((a, b) => compareVersions(String(b.version ?? '0'), String(a.version ?? '0')))[0];
}

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

export function liveRoot(name: string, ctx: RootContext): string | null {
  const fs = ctx.fs ?? realFs;
  const claudeDir = ctx.claudeDir || join(ctx.home, '.claude');

  const env = ctx.env?.[`KS_ROOT_${name.toUpperCase().replace(/-/g, '_')}`];
  if (env && fs.isDir(env)) return env;

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

  const reg = readJson<Record<string, { root?: string; mode?: string }>>(fs, join(ctx.configDir, 'plugins.json'));
  const rec = reg?.[name];
  if (rec?.mode === 'local' && rec.root && fs.isDir(rec.root)) return rec.root;

  if (ctx.pluginsDir) {
    const dir = join(ctx.pluginsDir, name);
    if (fs.isDir(dir) && declaresName(fs, dir, name)) return dir;
  }
  return null;
}

/** The plugins/ folder holding ks-flow: the board runs with cwd <ks-flow>/web. */
function ownPluginsDir(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (declaresName(realFs, dir, 'ks-flow')) return dirname(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function rootContext(): RootContext {
  const home = homedir();
  return {
    home,
    configDir: process.env.KS_CONFIG_DIR || join(home, '.config', 'ks'),
    cwd: process.cwd(),
    projectPath: process.env.KS_PROJECT_ROOT_PATH ? expandHome(process.env.KS_PROJECT_ROOT_PATH, home) : undefined,
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    pluginsDir: ownPluginsDir(),
    env: process.env,
  };
}

export function flowPluginRoot(): string | null {
  const env = process.env.KS_FLOW_PLUGIN_ROOT;
  if (env && existsSync(env)) return env;
  return liveRoot('ks-flow', rootContext());
}
