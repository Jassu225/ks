/**
 * Shared Claude memory (ks.KS_MEMORY_DIR): a private git repo, one folder per
 * project, that every Mac's Claude Code reads through `autoMemoryDirectory`
 * (`ks-setup memory init|link`). This keeps it in sync, with no periodic fetch:
 *
 * - push: a change to a project's index (`<project>/MEMORY.md`, which every
 *   memory save or delete updates) marks the repo dirty; each further change
 *   restarts a 2-min quiet window; once it passes, the daemon's 15 s clock runs
 *   one sync (commit everything, pull --rebase, push) and publishes the new
 *   HEAD as devices/{self}.memoryHead.
 * - pull: another device's memoryHead that this clone doesn't have yet (seen
 *   through the devices listener the daemon already holds) asks for a sync.
 * - the daemon's start asks for one too (changes made while it was down).
 *
 * A failed sync stays wanted and is tried again 2 min later. Before each
 * commit, the changed memories' home paths are written as `~/…`: every Mac
 * reads the same files, and the home folder differs per Mac.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Quiet time after the last index change before a sync. */
export const QUIET_MS = 120_000;
/** A failed sync is tried again this much later. */
export const RETRY_MS = 120_000;

export interface GitResult {
  code: number;
  out: string;
}
/** Runs git in a folder; never throws on a non-zero exit. */
export type GitRun = (args: string[], cwd: string) => Promise<GitResult>;

/** Plain git (tests); the daemon passes one that goes through the login shell. */
export const plainGit: GitRun = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });

/** A watched path (relative to the clone) that marks the repo dirty: a project's index. */
export function isIndexPath(rel: string): boolean {
  return /^[^/\\]+[/\\]MEMORY\.md$/.test(rel);
}

/** The home folder written as `~`: `/Users/x/git/ks` → `~/git/ks`. */
export function homeToTilde(text: string, home: string): string {
  const h = home.replace(/\/+$/, '');
  if (!h || h === '/') return text;
  return text.split(`${h}/`).join('~/');
}

export interface SyncState {
  /** The first index change not yet synced; reset by each further change. */
  dirtySince: number | null;
  /** A full sync (pull included) is wanted: daemon start, or another device pushed. */
  pullWanted: boolean;
  /** No attempt before this (after a failure). */
  retryAt: number;
}

/** What the 15 s tick should do now: a full sync, a push-only sync, or nothing. */
export function whatToDo(s: SyncState, now: number, quietMs = QUIET_MS): 'pull' | 'push' | null {
  if (now < s.retryAt) return null;
  if (s.pullWanted) return 'pull';
  if (s.dirtySince !== null && now - s.dirtySince >= quietMs) return 'push';
  return null;
}

export interface SyncOutcome {
  /** HEAD after the sync. */
  head: string;
  /** Files this Mac committed (0: nothing of its own). */
  committed: number;
  /** HEAD moved (a commit of ours, or one pulled in). */
  changed: boolean;
}

export class MemorySync {
  readonly state: SyncState = { dirtySince: null, pullWanted: true, retryAt: 0 };
  private running: Promise<SyncOutcome | null> | null = null;

  constructor(
    readonly dir: string,
    private readonly git: GitRun,
    private readonly opts: { home: string; label: string },
  ) {}

  /** The watcher saw `rel` change: an index change (re)starts the quiet window. */
  changed(rel: string, now: number): void {
    if (isIndexPath(rel)) this.state.dirtySince = now;
  }

  /** Another device published `head`; a sync is wanted unless this clone already has it. */
  async seen(head: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,64}$/.test(head)) return false;
    const r = await this.git(['cat-file', '-e', `${head}^{commit}`], this.dir);
    if (r.code !== 0) this.state.pullWanted = true;
    return r.code !== 0;
  }

  /** The 15 s tick: runs the sync that is due, if any. Throws a failed sync's error. */
  async tick(now: number): Promise<SyncOutcome | null> {
    const what = whatToDo(this.state, now);
    if (!what || this.running) return null;
    const dirtyAt = this.state.dirtySince;
    this.running = this.sync(what === 'pull');
    try {
      const out = await this.running;
      if (what === 'pull') this.state.pullWanted = false;
      // A change during the sync keeps its own window.
      if (this.state.dirtySince === dirtyAt) this.state.dirtySince = null;
      return out;
    } catch (e) {
      this.state.retryAt = now + RETRY_MS;
      throw e;
    } finally {
      this.running = null;
    }
  }

  /** One sync: commit local changes, then (when pulling or after a commit) pull --rebase and push. */
  async sync(pull: boolean): Promise<SyncOutcome | null> {
    const g = (...args: string[]) => this.git(args, this.dir);
    const before = (await g('rev-parse', 'HEAD')).out;
    const status = await g('status', '--porcelain', '-z', '--untracked-files=all');
    if (status.code !== 0) throw new Error(`git status: ${status.out}`);
    const files = changedFiles(status.out);
    if (!files.length && !pull) return null; // nothing of ours, nothing asked: no network
    for (const f of files) this.tildeHome(f);
    let committed = 0;
    if (files.length) {
      await g('add', '-A');
      const staged = (await g('diff', '--cached', '--name-only')).out.split('\n').filter(Boolean);
      if (staged.length) {
        const c = await g('commit', '-q', '-m', `memory: ${this.opts.label}, ${staged.length} file(s)`);
        if (c.code !== 0) throw new Error(`git commit: ${c.out}`);
        committed = staged.length;
      }
    }
    if (!committed && !pull) return null;
    const hasUpstream = (await g('rev-parse', '--abbrev-ref', '@{u}')).code === 0;
    if (hasUpstream) {
      const p = await g('pull', '-q', '--rebase', '--autostash');
      if (p.code !== 0) {
        const conflicts = (await g('diff', '--name-only', '--diff-filter=U')).out.split('\n').filter(Boolean);
        if (existsSync(join(this.dir, '.git', 'rebase-merge')) || existsSync(join(this.dir, '.git', 'rebase-apply'))) {
          await g('rebase', '--abort');
        }
        throw new Error(
          conflicts.length
            ? `memory conflict in ${conflicts.join(', ')}: resolve it in ${this.dir} (git pull --rebase), then the next sync pushes`
            : `git pull: ${lastLines(p.out)}`,
        );
      }
    }
    const ahead = hasUpstream ? (await g('rev-list', '--count', '@{u}..HEAD')).out.trim() : '1';
    if (ahead !== '0') {
      const push = await g('push', '-q', ...(hasUpstream ? [] : ['-u', 'origin', 'HEAD']));
      if (push.code !== 0) throw new Error(`git push: ${lastLines(push.out)}`);
    }
    const head = (await g('rev-parse', 'HEAD')).out;
    return { head, committed, changed: head !== before };
  }

  /** A changed memory's home paths as `~/…`. */
  private tildeHome(rel: string): void {
    if (!rel.endsWith('.md')) return;
    const p = join(this.dir, rel);
    try {
      const text = readFileSync(p, 'utf8');
      const fixed = homeToTilde(text, this.opts.home);
      if (fixed !== text) writeFileSync(p, fixed);
    } catch {
      // deleted, or not a file: nothing to rewrite
    }
  }
}

/** The paths in `git status --porcelain -z` output (a rename's new path). */
export function changedFiles(z: string): string[] {
  const parts = z.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    out.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) i++; // the old path follows
  }
  return out;
}

function lastLines(s: string): string {
  return s.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
