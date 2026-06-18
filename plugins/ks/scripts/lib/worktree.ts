import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawn } from 'child_process';
import { SCRIPTS_DIR } from './env.js';

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
 * Create a git worktree and launch Claude with the KS plugin.
 *
 * @param worktreeName - Branch or slug name for the worktree
 * @param workflowRelPath - Relative path to the workflow directory
 * @param outputPath - Absolute path to the state.yaml file
 */
export function createWorktreeAndLaunchClaude(
  worktreeName: string,
  workflowRelPath: string,
  outputPath: string,
): void {
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

    // Launch via `claude-ks`, NOT plain `claude`. claude-ks loads the ks plugin
    // AND every KS_EXTRA_PLUGINS entry (e.g. ks-flow → session tracking + the
    // stop/waiting notification hooks) plus ks-rules — exactly like a manual
    // launch. The old path spawned plain `claude` with only the ks plugin (and
    // only under DEV), so KST-created worktree sessions never loaded ks-flow:
    // its hooks never fired, the session went untracked, and no notifications
    // were sent. Delegating to claude-ks keeps a single source of truth for
    // which plugins load.
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
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      console.error(chalk.red(`\n✗ Failed to create worktree`));
      process.exit(1);
    }
    throw error;
  }
}
