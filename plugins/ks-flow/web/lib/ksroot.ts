// lib/ksroot.ts — SERVER-only: the ks-flow plugin's own folder for the board's
// API routes. KS_FLOW_PLUGIN_ROOT (exported by `ks-flow open`) unless that
// folder is gone (an installed plugin's version folder is replaced on update),
// then the KS registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json, which each
// SessionStart records (see src/lib/ksroot.ts for the daemon's fuller lookup).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function flowPluginRoot(): string | null {
  const env = process.env.KS_FLOW_PLUGIN_ROOT;
  if (env && existsSync(env)) return env;
  try {
    const file = join(process.env.KS_CONFIG_DIR || join(homedir(), '.config', 'ks'), 'plugins.json');
    const root = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { root?: string }>)['ks-flow']?.root;
    return root && existsSync(root) ? root : null;
  } catch {
    return null;
  }
}
