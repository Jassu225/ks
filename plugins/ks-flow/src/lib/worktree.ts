// lib/worktree.ts — git-common-dir membership + worktree enumeration.
//
// Membership key = the shared git-common-dir. All worktrees of a repo share
// one common git dir, so a session belongs to the project iff its cwd's
// resolved common-dir equals PROJECT_COMMON_DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the absolute, realpath'd git-common-dir for a working directory.
 * ENOENT-safe (returns null if cwd is gone or not a git repo).
 */
export function commonDir(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  const raw = git(cwd, ['rev-parse', '--git-common-dir']);
  if (raw === null) return null;
  // `--git-common-dir` may be relative to cwd (".git").
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return realpathSafe(abs);
}

/** The worktree root containing `cwd` (`git rev-parse --show-toplevel`). */
export function toplevel(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top ? realpathSafe(top) : null;
}

export interface Worktree {
  path: string;
  branch: string | null;
}

/** `git worktree list --porcelain` → absolute, realpath'd worktree paths. */
export function listWorktrees(projectPath: string): Worktree[] {
  const out = git(projectPath, ['worktree', 'list', '--porcelain']);
  if (out === null) return [];
  const trees: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null });
      cur = { path: realpathSafe(line.slice('worktree '.length)) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === '' && cur.path) {
      trees.push({ path: cur.path, branch: cur.branch ?? null });
      cur = {};
    }
  }
  if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null });
  return trees;
}

/**
 * Decide whether a session cwd belongs to the tracked project.
 * Primary: common-dir equality. Fallback (cwd gone / not a repo): path-prefix
 * match against the last-known worktree paths.
 */
export function isInProject(
  cwd: string,
  projectCommonDir: string,
  knownWorktrees: string[] = [],
): boolean {
  const cd = commonDir(cwd);
  if (cd !== null) return cd === projectCommonDir;
  const c = realpathSafe(cwd);
  return knownWorktrees.some((w) => c === w || c.startsWith(w + '/'));
}
