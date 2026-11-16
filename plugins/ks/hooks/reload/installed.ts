/**
 * Which KS plugin folders, at which versions, a `/reload-plugins` would load
 * now, and whether that differs from what this module loaded (auto-reload.ts).
 *
 * A plugin's live folder is found the way the ks plugin's lib/ks-root.sh
 * (`ksr_live_root`) and ks-flow's src/lib/ksroot.ts (`liveRoot`) find it,
 * from Claude Code's own records each time, never from a remembered
 * versioned cache folder:
 *   1. KS_ROOT_<NAME> (upper-cased, - → _)
 *   2. a directory marketplace: known_marketplaces.json's karmasuite entry with
 *      source.source == "directory" → <installLocation>/plugins/<name> (its
 *      plugin.json must name <name>); Claude Code reads it in place, so stale
 *      cache entries in installed_plugins.json don't count
 *   3. the chosen installed_plugins.json (v2) entry of <name>@karmasuite,
 *      skipping entries whose installPath is gone: the local/project entry
 *      whose projectPath contains cwd (longest), then the KS checkout's entry
 *      (projectPath == KS_PROJECT_ROOT_PATH, env or ${KS_CONFIG_DIR}/ks.env),
 *      then a user/managed entry, then the highest version
 *   4. the registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json, entries with
 *      mode "local" (a clone) only
 *   5. the sibling folder next to the ks plugin (a clone: plugins/<name>; its
 *      plugin.json must name <name>)
 * Never `claude plugin list`: a hooks module runs no `claude`.
 *
 * Pure: every read goes through the `RootFs` handed in (the mod's `$.fs`,
 * an in-memory one in tests). Only plugin.json versions are compared, in
 * either mode: a directory marketplace keeps one folder whose plugin.json
 * moves, a marketplace install gets a new versioned folder.
 */

export const KS_MARKETPLACE = 'karmasuite'

/** File access liveRoot needs: the mod's `$.fs`, or an in-memory one. */
export interface RootFs {
  /** The file's text, or null when it can't be read. */
  read(path: string): Promise<string | null>
  isDir(path: string): Promise<boolean>
}

export interface RootContext {
  home: string
  /** The KS config folder: ${KS_CONFIG_DIR:-~/.config/ks} (registry, ks.env). */
  configDir: string
  /** Claude Code's config folder: ${CLAUDE_CONFIG_DIR:-<home>/.claude}. */
  claudeDir: string
  /** The session's directory. */
  cwd: string
  /** The KS checkout (KS_PROJECT_ROOT_PATH); undefined → read <configDir>/ks.env. */
  projectPath?: string | null
  /** The folder holding the ks plugin and its siblings (a clone's plugins/). */
  pluginsDir?: string | null
  /** Where KS_ROOT_<NAME> is read. */
  env?: Record<string, string | undefined>
  fs: RootFs
}

interface InstalledEntry {
  scope?: string
  projectPath?: string
  installPath?: string
  version?: string
  lastUpdated?: string
}

function join(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

async function readJson<T>(fs: RootFs, path: string): Promise<T | null> {
  const text = await fs.read(path)
  if (text == null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** plugin.json's `version`, or null. */
export function pluginVersionOf(text: string | null): string | null {
  if (!text) return null
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

async function declaresName(fs: RootFs, dir: string, name: string): Promise<boolean> {
  return (await readJson<{ name?: string }>(fs, join(dir, '.claude-plugin', 'plugin.json')))?.name === name
}

/** KS_PROJECT_ROOT_PATH from a ks.env text (last assignment wins, quotes stripped, ~ expanded). */
export function projectPathFromEnvFile(text: string | null, home: string): string | null {
  if (!text) return null
  let found: string | null = null
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?KS_PROJECT_ROOT_PATH\s*=\s*["']?([^"']*)["']?\s*$/.exec(line)
    if (m) found = m[1] ?? null
  }
  if (!found) return null
  return found.startsWith('~') ? home + found.slice(1) : found
}

/** Compare dotted versions numerically (1.0.10 > 1.0.9); non-numeric parts as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/)
  const pb = b.split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y)
    if (c !== 0) return c < 0 ? -1 : 1
  }
  return 0
}

/** The newest of some entries: highest version, then latest lastUpdated. */
function newest(entries: InstalledEntry[]): InstalledEntry | undefined {
  return [...entries].sort(
    (a, b) => compareVersions(b.version ?? '0', a.version ?? '0') || (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''),
  )[0]
}

/** Pick the installed entry a session in `cwd` loads (step 3 of the header) among entries whose installPath exists. */
export function chooseInstalled(live: InstalledEntry[], cwd: string, projectPath: string | null): InstalledEntry | null {
  if (live.length === 0) return null
  const here = trimSlash(cwd)
  const scoped = live.filter(e => (e.scope === 'local' || e.scope === 'project') && e.projectPath)
  const containing = scoped.filter(e => {
    const p = trimSlash(e.projectPath!)
    return here === p || here.startsWith(p === '/' ? '/' : `${p}/`)
  })
  if (containing.length) {
    const longest = Math.max(...containing.map(e => trimSlash(e.projectPath!).length))
    return newest(containing.filter(e => trimSlash(e.projectPath!).length === longest)) ?? null
  }
  if (projectPath) {
    const checkout = trimSlash(projectPath)
    const mine = scoped.filter(e => trimSlash(e.projectPath!) === checkout)
    if (mine.length) return newest(mine) ?? null
  }
  const wide = live.filter(e => e.scope === 'user' || e.scope === 'managed')
  if (wide.length) return newest(wide) ?? null
  return newest(live) ?? null
}

/** A KS plugin's current folder (steps 1–5 of the header), or null. */
export async function liveRoot(name: string, ctx: RootContext): Promise<string | null> {
  const { fs } = ctx

  // 1. KS_ROOT_<NAME>
  const env = ctx.env?.[`KS_ROOT_${name.toUpperCase().replace(/-/g, '_')}`]
  if (env && (await fs.isDir(env))) return env

  // 2. a directory marketplace, read in place
  const markets = await readJson<Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>>(
    fs,
    join(ctx.claudeDir, 'plugins', 'known_marketplaces.json'),
  )
  const market = markets?.[KS_MARKETPLACE]
  if (market?.source?.source === 'directory') {
    const location = market.installLocation || market.source.path
    if (location) {
      const dir = join(location, 'plugins', name)
      if ((await fs.isDir(dir)) && (await declaresName(fs, dir, name))) return dir
    }
  }

  // 3. the installed entry this cwd / the KS checkout loads
  const installed = await readJson<{ plugins?: Record<string, InstalledEntry[]> }>(fs, join(ctx.claudeDir, 'plugins', 'installed_plugins.json'))
  const entries = installed?.plugins?.[`${name}@${KS_MARKETPLACE}`]
  if (Array.isArray(entries)) {
    const live: InstalledEntry[] = []
    for (const e of entries) if (e && typeof e.installPath === 'string' && e.installPath && (await fs.isDir(e.installPath))) live.push(e)
    const projectPath =
      ctx.projectPath !== undefined ? ctx.projectPath : projectPathFromEnvFile(await fs.read(join(ctx.configDir, 'ks.env')), ctx.home)
    const chosen = chooseInstalled(live, ctx.cwd, projectPath || null)
    if (chosen?.installPath) return chosen.installPath
  }

  // 4. the registry, clones only
  const reg = await readJson<Record<string, { root?: string; mode?: string }>>(fs, join(ctx.configDir, 'plugins.json'))
  const rec = reg?.[name]
  if (rec?.mode === 'local' && rec.root && (await fs.isDir(rec.root))) return rec.root

  // 5. the sibling folder
  if (ctx.pluginsDir) {
    const dir = join(ctx.pluginsDir, name)
    if ((await fs.isDir(dir)) && (await declaresName(fs, dir, name))) return dir
  }
  return null
}

/** One plugin as loaded or as on disk: its folder and plugin.json version (null: not found / unreadable). */
export type PluginAt = { root: string | null; version: string | null }
/** Plugin name → where it is, in the order the plugins are named. */
export type PluginSet = Record<string, PluginAt>

/** The plugin.json version in `root`. */
export async function versionAt(fs: RootFs, root: string | null): Promise<string | null> {
  return root ? pluginVersionOf(await fs.read(join(root, '.claude-plugin', 'plugin.json'))) : null
}

/**
 * Each named plugin's live folder and version now. A plugin with no live
 * folder is read where `loaded` says it was (so the ks plugin is never left
 * out of the target only because its records could not be read).
 */
export async function currentPlugins(names: readonly string[], ctx: RootContext, loaded: PluginSet = {}): Promise<PluginSet> {
  const out: PluginSet = {}
  for (const name of names) {
    const root = (await liveRoot(name, ctx)) ?? loaded[name]?.root ?? null
    out[name] = { root, version: await versionAt(ctx.fs, root) }
  }
  return out
}

/**
 * A set's target string, `ks@1.0.7,ks-flow@0.3.0`, in the order given;
 * plugins whose version is unknown are left out. Null when none is known.
 */
export function targetOf(set: PluginSet, names: readonly string[]): string | null {
  const parts = names.flatMap(n => (set[n]?.version ? [`${n}@${set[n]!.version}`] : []))
  return parts.length ? parts.join(',') : null
}

/** What a reload would load: the target string, and each plugin that changed (for the notice). */
export type ReloadOffer = { target: string; changed: { plugin: string; from: string; to: string }[] }

/**
 * The offer when a plugin's live version differs from the loaded one (either
 * way: a downgrade on disk is what the next session loads too), else null.
 * A plugin whose version is unknown on either side is not compared.
 */
export function reloadOffer(loaded: PluginSet, current: PluginSet, names: readonly string[]): ReloadOffer | null {
  const changed = names.flatMap(plugin => {
    const from = loaded[plugin]?.version
    const to = current[plugin]?.version
    return from && to && from !== to ? [{ plugin, from, to }] : []
  })
  if (changed.length === 0) return null
  const target = targetOf(current, names)
  return target ? { target, changed } : null
}

/** The notice's words for an offer: `ks 1.0.7, ks-flow 0.3.0`. */
export function offerLabel(offer: ReloadOffer): string {
  return offer.changed.map(c => `${c.plugin} ${c.to}`).join(', ')
}
