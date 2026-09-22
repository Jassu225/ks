import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawn } from 'child_process';
import { SCRIPTS_DIR } from './env.js';

/** Seconds the reuse notice stays on screen before launching on its own. */
const REUSE_NOTICE_SECONDS = 10;

/**
 * Replace absolute home path prefix with ~
 */
export function tildeify(absolutePath: string): string {
  const home = process.env.HOME || '';
  return home && absolutePath.startsWith(home) ? '~' + absolutePath.slice(home.length) : absolutePath;
}

/**
 * Update the worktree_dir field in a state.yaml file.
 */
export function updateWorktreeDir(outputPath: string, worktreePath: string): void {
  const content = fs.readFileSync(outputPath, 'utf-8');
  const updated = content.replace(/^worktree_dir:.*$/m, `worktree_dir: "${tildeify(worktreePath)}"`);
  fs.writeFileSync(outputPath, updated, 'utf-8');
}

/**
 * Where `create-worktree` would put a worktree of this name.
 *
 * Mirrors the path that script derives (`WORKTREES_BASE_DIR` at :41, sibling to
 * the main repo) -- the two must stay in sync. Returns null when the caller is
 * not inside a git repo, so the callers fall through to `create-worktree` and
 * let it report the problem.
 */
export function resolveWorktreePath(worktreeName: string): string | null {
  const targetDir = process.env.KS_ORIGINAL_DIR || process.cwd();
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.join(path.dirname(repoRoot), 'karmasuite-worktree', worktreeName);
  } catch {
    return null;
  }
}

/** The worktree for this name, if it is already on disk. */
export function findExistingWorktree(worktreeName: string): string | null {
  const candidate = resolveWorktreePath(worktreeName);
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

/**
 * Hold for `seconds`, or until the user presses ENTER.
 *
 * Nothing is being decided here -- the launch happens either way. The pause
 * only gives the notice above it time to be read.
 */
function waitOrEnter(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const interactive = Boolean(stdin.isTTY);
    let remaining = seconds;

    const render = () => {
      const hint = interactive ? ' — press ENTER to launch now' : '';
      process.stdout.write(`\r  ${chalk.cyan(`Launching in ${remaining}s${hint}...`)}   `);
    };

    const finish = () => {
      clearInterval(timer);
      if (interactive) {
        stdin.removeListener('data', onData);
        stdin.pause();
      }
      process.stdout.write('\r\x1b[K');
      resolve();
    };

    const onData = (chunk: Buffer) => {
      if (chunk.includes('\n') || chunk.includes('\r')) finish();
    };

    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        finish();
        return;
      }
      render();
    }, 1000);

    render();

    if (interactive) {
      stdin.resume();
      stdin.on('data', onData);
    }
  });
}

/**
 * Put the freshly written state.yaml into the worktree too.
 *
 * `create-worktree` copies `workflow/` on creation; on reuse nothing has
 * copied it, so the worktree would otherwise keep the state from the last
 * session -- without the refreshed ticket data.
 */
function syncStateIntoWorktree(outputPath: string, worktreePath: string, workflowRelPath: string): void {
  updateWorktreeDir(outputPath, worktreePath);

  const worktreeStatePath = path.join(worktreePath, workflowRelPath, 'state.yaml');
  if (path.resolve(worktreeStatePath) === path.resolve(outputPath)) return;

  fs.mkdirSync(path.dirname(worktreeStatePath), { recursive: true });
  fs.copyFileSync(outputPath, worktreeStatePath);
}

/**
 * Launch Claude in `worktreePath` via `claude-ks`.
 *
 * Launch via `claude-ks`, NOT plain `claude`. claude-ks loads the ks plugin
 * AND every KS_EXTRA_PLUGINS entry (e.g. ks-flow → session tracking + the
 * stop/waiting notification hooks) plus ks-rules — exactly like a manual
 * launch. The old path spawned plain `claude` with only the ks plugin (and
 * only under DEV), so KST-created worktree sessions never loaded ks-flow:
 * its hooks never fired, the session went untracked, and no notifications
 * were sent. Delegating to claude-ks keeps a single source of truth for
 * which plugins load.
 */
function launchClaude(worktreePath: string, workflowRelPath: string): void {
  console.log(chalk.blue('\nLaunching Claude (claude-ks) in worktree...'));
  console.log(chalk.yellow(`\n💡 Start your conversation with:`));
  console.log(chalk.bold(`   /ks:project-manager Let's work on ./${workflowRelPath}/ project\n`));
  process.chdir(worktreePath);

  const claudeKs = path.join(SCRIPTS_DIR, 'claude-ks');
  const initialPrompt = `/ks:project-manager Let's work on ./${workflowRelPath}/ project`;
  const claude = spawn(claudeKs, [initialPrompt], {
    stdio: 'inherit',
  });

  claude.on('error', (err) => {
    console.error(chalk.red(`Failed to launch claude: ${err.message}`));
    process.exit(1);
  });

  claude.on('close', (code) => {
    process.exit(code || 0);
  });
}

/**
 * Create a git worktree and launch Claude with the KS plugin.
 *
 * A worktree already on disk for this name is worked in as it stands: a
 * reopened ticket keeps its branch and its uncommitted work, and
 * `create-worktree` -- which refuses an existing worktree or branch -- is
 * never reached.
 *
 * @param worktreeName - Branch or slug name for the worktree
 * @param workflowRelPath - Relative path to the workflow directory
 * @param outputPath - Absolute path to the state.yaml file
 */
export async function createWorktreeAndLaunchClaude(
  worktreeName: string,
  workflowRelPath: string,
  outputPath: string,
): Promise<void> {
  const existingWorktree = findExistingWorktree(worktreeName);

  if (existingWorktree) {
    console.log(chalk.green(`\n✓ Worktree already exists — working in it instead of creating one`));
    console.log(chalk.gray(`  Path:   ${tildeify(existingWorktree)}`));
    console.log(chalk.gray(`  Branch: ${worktreeName} (kept as-is, along with any uncommitted work)`));

    syncStateIntoWorktree(outputPath, existingWorktree, workflowRelPath);

    await waitOrEnter(REUSE_NOTICE_SECONDS);
    launchClaude(existingWorktree, workflowRelPath);
    return;
  }

  const createWorktreeScript = path.join(SCRIPTS_DIR, 'create-worktree');

  console.log(chalk.blue('\nCreating git worktree...'));

  try {
    const targetDir = process.env.KS_ORIGINAL_DIR || process.cwd();
    const output = execSync(`"${createWorktreeScript}" "${worktreeName}"`, {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: targetDir,
    });

    const worktreePathMatch = output.match(/WORKTREE_PATH=(.+)/);
    if (!worktreePathMatch) {
      throw new Error('Could not determine worktree path from create-worktree output');
    }

    const worktreePath = worktreePathMatch[1].trim();

    // Update state file with worktree directory (original repo copy)
    updateWorktreeDir(outputPath, worktreePath);

    // Also update the worktree copy (create-worktree copies workflow/ into the worktree)
    const worktreeStatePath = path.join(worktreePath, workflowRelPath, 'state.yaml');
    if (fs.existsSync(worktreeStatePath)) {
      updateWorktreeDir(worktreeStatePath, worktreePath);
    }

    launchClaude(worktreePath, workflowRelPath);
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      console.error(chalk.red(`\n✗ Failed to create worktree`));
      process.exit(1);
    }
    throw error;
  }
}
