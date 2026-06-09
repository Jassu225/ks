// lib/paths.ts — filesystem locations and the cwd↔projects-dir encoding.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** ~/.claude/projects — one dir per encoded cwd, *.jsonl per session. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export const DATA_DIR = dataDir();
export const EVENTS_PATH = join(DATA_DIR, 'events.jsonl');
/** Daemon log — the daemon opens this truncating ('w') on every start, so it
 * holds only the current run (launchd's StandardOutPath would append forever). */
export const DAEMON_LOG_PATH = join(DATA_DIR, 'daemon.log');
export const CHECKPOINTS_PATH = join(DATA_DIR, 'checkpoints.json');
export const PROJECT_CONF_PATH = join(DATA_DIR, 'project.conf');

/** PocketBase install + state (the local default provider). The binary is
 * downloaded by bootstrap; pb_data holds its SQLite store; pb_migrations is
 * copied in from the plugin so `serve` provisions the schema on first run. */
export const POCKETBASE_DIR = join(DATA_DIR, 'pocketbase');
export const POCKETBASE_BIN = join(POCKETBASE_DIR, 'pocketbase');
export const POCKETBASE_DATA = join(POCKETBASE_DIR, 'pb_data');
export const POCKETBASE_MIGRATIONS = join(POCKETBASE_DIR, 'pb_migrations');

/**
 * Claude Code encodes a session cwd into a projects/ dir name by replacing
 * every "/" and "." with "-" (verified: /Users/jassu/.claude →
 * -Users-jassu--claude). The mapping is LOSSY — a "-" in the encoded name may
 * have been "/", ".", or a literal "-" — so it is forward-only. Never decode;
 * enumerate worktree paths and encode them, then confirm membership by reading
 * the file's own cwd.
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

/** ~/.claude/projects/<encoded>. */
export function projectDirFor(absCwd: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodeProjectDir(absCwd));
}

/** Expand a leading "~" to the home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Workflow root for a project: <projectPath>/workflow/<username>. */
export function workflowDir(projectPath: string, username: string): string {
  return join(projectPath, 'workflow', username);
}
