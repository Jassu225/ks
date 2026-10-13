import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawn, spawnSync } from 'child_process';
import * as readline from 'readline';
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
 *
 * A state.yaml written before the field existed has no line to replace; add it
 * above the top-level `ticket:` / `project:` key (where ks-start-ticket writes
 * it). Leaving it out made `remove_worktree` refuse the worktree and ks-flow
 * unable to tell which unit the worktree belongs to.
 */
export function updateWorktreeDir(outputPath: string, worktreePath: string): void {
  const content = fs.readFileSync(outputPath, 'utf-8');
  const line = `worktree_dir: "${tildeify(worktreePath)}"`;
  const updated = /^worktree_dir:.*$/m.test(content)
    ? content.replace(/^worktree_dir:.*$/m, line)
    : content.replace(
        /^(ticket|project):/m,
        `# Git worktree directory (updated after worktree creation)\n${line}\n$1:`,
      );
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

/** Ask a yes/no question; ENTER means yes. Without a terminal, the answer is no. */
function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(!/^n/i.test(answer.trim()));
    });
  });
}

/**
 * Offer to bring back a ticket's sessions (and any missing workflow files) from
 * ks-flow's cloud backup, when that backup is switched on (`ks-flow
 * backup-enabled`: gcsArchive.enabled in the board settings). Runs after
 * worktree_dir is written, so ks-flow resolves this worktree as the unit's live
 * one and the sessions land where `--resume` in it will list them.
 *
 * Best effort: no ks-flow, backup off, nothing missing, or the bucket
 * unreachable -- each just moves on. Starting a ticket never fails here.
 */
async function offerCloudRestore(unitId: string, worktreePath: string): Promise<void> {
  const ksFlow = (args: string[], inherit = false) =>
    spawnSync('ks-flow', args, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      timeout: inherit ? undefined : 120_000,
    });

  const enabled = ksFlow(['backup-enabled']);
  if (enabled.error || enabled.status !== 0) return; // not installed, or cloud backup off

  console.log(chalk.gray(`
Checking ks-flow cloud backup for ${unitId}...`));
  const probe = ksFlow(['restore', '--unit', unitId, '--workflow', '--dry-run', '--json']);
  let plan: { ok?: boolean; error?: string; restored?: string[]; workflow?: { restored: number } | null };
  try {
    plan = JSON.parse((probe.stdout || '').trim().split('\n').pop() || '{}');
  } catch {
    console.log(chalk.yellow('  Could not read the cloud backup — skipping restore.'));
    return;
  }
  if (plan.error) {
    console.log(chalk.gray(`  ${plan.error}`));
    return;
  }
  const sessions = plan.restored?.length ?? 0;
  const workflowFiles = plan.workflow?.restored ?? 0;
  if (sessions === 0 && workflowFiles === 0) {
    console.log(chalk.gray('  Nothing missing locally.'));
    return;
  }

  const what = [
    sessions ? `${sessions} session(s)` : '',
    workflowFiles ? `${workflowFiles} workflow file(s)` : '',
  ]
    .filter(Boolean)
    .join(' + ');
  if (!(await confirm(chalk.cyan(`  Cloud backup has ${what} missing on this machine. Restore? [Y/n] `)))) {
    console.log(chalk.gray(`  Skipped. Later: ks-flow restore --unit ${unitId} --workflow`));
    return;
  }
  const res = ksFlow(['restore', '--unit', unitId, '--workflow'], true);
  if (res.status !== 0) {
    console.log(chalk.yellow(`  Restore did not finish cleanly — retry with: ks-flow restore --unit ${unitId} --workflow`));
  }
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
 * @param unitId - The ticket identifier, to offer a restore from ks-flow's cloud backup
 */
export async function createWorktreeAndLaunchClaude(
  worktreeName: string,
  workflowRelPath: string,
  outputPath: string,
  unitId?: string,
): Promise<void> {
  const existingWorktree = findExistingWorktree(worktreeName);

  if (existingWorktree) {
    console.log(chalk.green(`\n✓ Worktree already exists — working in it instead of creating one`));
    console.log(chalk.gray(`  Path:   ${tildeify(existingWorktree)}`));
    console.log(chalk.gray(`  Branch: ${worktreeName} (kept as-is, along with any uncommitted work)`));

    syncStateIntoWorktree(outputPath, existingWorktree, workflowRelPath);
    if (unitId) await offerCloudRestore(unitId, existingWorktree);

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

    if (unitId) await offerCloudRestore(unitId, worktreePath);
    launchClaude(worktreePath, workflowRelPath);
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      console.error(chalk.red(`\n✗ Failed to create worktree`));
      process.exit(1);
    }
    throw error;
  }
}
