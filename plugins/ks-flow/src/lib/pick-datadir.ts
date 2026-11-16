// lib/pick-datadir.ts — the data dir a hand-run tool (the one-off device
// backfill) acts on, chosen the way bin/ks-flow chooses it, so it works from
// any directory:
//   1. --data-dir (the caller passes it)        4. the current directory's
//   2. $KS_FLOW_DATA                                 project, when configured
//   3. $CLAUDE_PLUGIN_OPTION_project_path's dir   5. the only configured project
//                                                6. else the current directory's
// "Configured" = the dir holds a project.conf. The derivation itself is
// lib/datadir.mjs (one implementation for every entity).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from './datadir.mjs';

export interface PickedDataDir {
  dir: string;
  why: string;
  /** Several projects are configured and none was chosen: the cwd's was taken. */
  ambiguous: boolean;
}

/** Every data dir under ~/.claude/plugins/data/ks-flow that holds a project.conf. */
export function configuredDataDirs(root = join(homedir(), '.claude', 'plugins', 'data', 'ks-flow')): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'project.conf')))
      .map((d) => join(root, d.name))
      .sort();
  } catch {
    return [];
  }
}

export function pickDataDir(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Overrides for tests. */
  configured?: string[];
  derive?: (cwd: string) => string;
}): PickedDataDir {
  const env = opts.env ?? process.env;
  if (opts.flag) return { dir: opts.flag, why: '--data-dir', ambiguous: false };
  if (env.KS_FLOW_DATA) return { dir: env.KS_FLOW_DATA, why: 'KS_FLOW_DATA', ambiguous: false };
  // datadir.mjs reads KS_FLOW_DATA itself; it is unset here.
  const derive = opts.derive ?? ((cwd: string) => resolveDataDir({ cwd }));
  const projectPath = env.CLAUDE_PLUGIN_OPTION_project_path?.replace(/^~(?=\/|$)/, homedir());
  if (projectPath) return { dir: derive(projectPath), why: 'CLAUDE_PLUGIN_OPTION_project_path', ambiguous: false };
  const cwdDir = derive(opts.cwd ?? process.cwd());
  if (existsSync(join(cwdDir, 'project.conf'))) return { dir: cwdDir, why: 'the current directory’s project', ambiguous: false };
  const configured = opts.configured ?? configuredDataDirs();
  if (configured.length === 1) return { dir: configured[0], why: 'the only configured project', ambiguous: false };
  return { dir: cwdDir, why: 'the current directory', ambiguous: configured.length > 1 };
}
