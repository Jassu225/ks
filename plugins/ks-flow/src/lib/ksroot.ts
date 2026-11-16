// lib/ksroot.ts — find a KS plugin's folder from the daemon (launchd: no
// plugin env, bare PATH), the same order as the ks plugin's lib/ks-root.sh:
//   1. KS_ROOT_<NAME> (upper-cased, - → _)
//   2. the registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json (each plugin's
//      SessionStart hook records ${CLAUDE_PLUGIN_ROOT}, so it follows updates)
//   3. `claude plugin list --json` through the login shell: readFromFolder (a
//      directory marketplace is read in place), else installPath
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function registryPath(): string {
  return join(process.env.KS_CONFIG_DIR || join(homedir(), '.config', 'ks'), 'plugins.json');
}

export function fromRegistry(name: string, file = registryPath()): string | null {
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { root?: string }>;
    const root = reg[name]?.root;
    return root && existsSync(root) ? root : null;
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
  const env = process.env[`KS_ROOT_${name.toUpperCase().replace(/-/g, '_')}`];
  if (env && existsSync(env)) return env;
  const reg = fromRegistry(name);
  if (reg) return reg;
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
