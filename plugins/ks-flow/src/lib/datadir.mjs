// lib/datadir.mjs — the SINGLE source of truth for resolving ks-flow's data
// directory, shared across every entity (bash hooks + launchers via the CLI
// below; the daemon via `import`; the board's /api/project via the CLI).
//
// Plain dependency-free ESM so `node` runs it directly with NO build step —
// bootstrap.sh can call it before the daemon is ever compiled.
//
// The data dir is derived from the project's git-common-dir, so it is
// INDEPENDENT of how the plugin was loaded (inline vs marketplace). That kills
// the CLAUDE_PLUGIN_DATA `<plugin>-<marketplace>` split-brain where a hook and
// the daemon disagreed on where to read/write.
//
// Resolution precedence:
//   1. $KS_FLOW_DATA           — explicit override (escape hatch)
//   2. derived dir             — ~/.claude/plugins/data/ks-flow/<encoded-common-dir>
//   3. $CLAUDE_PLUGIN_DATA     — legacy fallback (mid-migration safety)
//   4. ~/.claude/plugins/data/ks-flow-karmasuite  — old hard-coded default
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const LEGACY_DEFAULT = join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite');

/**
 * Encode an absolute path the SAME way Claude Code encodes session cwds into
 * ~/.claude/projects dir names: every "/" and "." becomes "-". Lossy but
 * deterministic — see src/lib/paths.ts encodeProjectDir.
 * @param {string} commonDir
 * @returns {string}
 */
export function encodeCommonDir(commonDir) {
  return commonDir.replace(/[/.]/g, '-');
}

/**
 * The per-project data dir for a given (already absolute, realpath'd) common-dir.
 * @param {string} commonDir
 * @returns {string}
 */
export function dataDirForCommonDir(commonDir) {
  return join(homedir(), '.claude', 'plugins', 'data', 'ks-flow', encodeCommonDir(commonDir));
}

/**
 * Resolve the realpath'd git-common-dir for a working directory (or any path
 * inside the repo). Returns null when it is not a git repo. Mirrors the bash
 * logic that previously lived in _common.sh / bootstrap.sh.
 * @param {string} cwd
 * @returns {string|null}
 */
export function gitCommonDir(cwd) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  // realpath the parent then re-join the basename, matching the bash `cd
  // dirname && pwd -P` dance (the .git dir itself always exists here).
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/**
 * Resolve ks-flow's data directory.
 * @param {{ cwd?: string, commonDir?: string }} [opts]
 *   cwd       — a working dir inside the project (its common-dir is computed)
 *   commonDir — an already-resolved common-dir (skips the git call)
 * @returns {string}
 */
export function resolveDataDir(opts = {}) {
  if (process.env.KS_FLOW_DATA) return process.env.KS_FLOW_DATA;
  const common = opts.commonDir ?? (opts.cwd ? gitCommonDir(opts.cwd) : null);
  if (common) return dataDirForCommonDir(common);
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return LEGACY_DEFAULT;
}

// --- CLI: `node datadir.mjs --cwd <path>` | `--project <path>` -------------
// Both flags take a path inside the repo and print the resolved data dir.
// Used by the bash entities (and the board's /api/project) so there is exactly
// one implementation. With no flag, prints resolveDataDir() (env-only).
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  let pathArg;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--cwd' || argv[i] === '--project') && argv[i + 1]) {
      pathArg = argv[++i];
    }
  }
  process.stdout.write(resolveDataDir(pathArg ? { cwd: pathArg } : {}));
}
