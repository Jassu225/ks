// lib/device-commands.ts — the message board: commands for one device's daemon.
//
// Something (the master, an agent, `ks-flow device-run`) posts a
// `deviceCommands/{uid}` doc naming a device (`to`), a command from the fixed
// list below and its arguments. That device's daemon follows its own commands
// with one listener (lib/live-sources.ts), checks each one, takes it
// (queued → running, atomically, so it runs once), runs it and writes the
// outcome back onto the doc: status, a one-line message, the end of the output.
// The board's Commands page lists them; the device that ran a command deletes
// it 30 days later.
//
// Never a shell command: each command maps to one KS script (or this daemon's
// own backup CLI) with checked arguments, passed as argv. A folder must be the
// KarmaSuite checkout or one of its live worktrees. And no free text: anyone
// who can write the store (the service-account key) must not be able to give a
// Claude session its first message, so a new session starts with the fixed
// project-manager prompt ks-start-ticket prints, or with none. Any other
// argument refuses the command.
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DeviceCommandDoc, DeviceCommandName, DeviceCommandStatus, DeviceStore } from './db/types.js';

/** A queued command older than this is not run (its asker has moved on). */
export const EXPIRE_MS = 15 * 60_000;
/** Finished commands are kept this long (the Commands page), then deleted. */
export const KEEP_MS = 30 * 86_400_000;
/** The end of the output kept on the doc. */
export const OUTPUT_MAX = 8000;

export const COMMANDS: Record<DeviceCommandName, string> = {
  ping: 'Check that the device answers: its ks-flow version.',
  'start-ticket': 'Start a ticket: prepare its worktree (ks-start-ticket) and open a claude-ks session there in a new window.',
  'new-session': 'Open a new claude-ks session in a folder (the KarmaSuite checkout or a worktree), in a new window, with no first message.',
  'restart-session': "Replace a ticket's running session with a fresh one (claude-ks-restart), in the same tmux pane.",
  backup: "Back up the device's sessions now (one ticket's with a unit), as the daily sweep does.",
};

export function isCommandName(v: unknown): v is DeviceCommandName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, v);
}

const TICKET = /^[A-Za-z]+-\d+$/;
const LINEAR_URL = /^https:\/\/linear\.app\/[^\s/]+\/issue\/[A-Za-z]+-\d+(?:\/[^\s]*)?$/;
const UNIT = /^[A-Za-z0-9._-]+$/;
/** The only arguments a command may carry. */
const ARGS = new Set(['ticket', 'dir', 'unit']);

export interface CommandContext {
  /** The KarmaSuite checkout, or null. */
  projectPath: string | null;
  /** The checkout's live worktrees (absolute paths). */
  worktrees: () => string[];
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Why a command can't run here, or null when it can. */
export function refusal(doc: Pick<DeviceCommandDoc, 'command' | 'args'>, ctx: CommandContext): string | null {
  if (!isCommandName(doc.command)) return `unknown command "${String(doc.command)}" (one of: ${Object.keys(COMMANDS).join(', ')})`;
  const a = doc.args ?? {};
  const extra = Object.keys(a).filter((k) => !ARGS.has(k));
  if (extra.length) return `unknown argument${extra.length > 1 ? 's' : ''} ${extra.join(', ')} (commands carry no free text: a session's first message is never taken from a command)`;
  switch (doc.command) {
    case 'ping':
      return null;
    case 'start-ticket':
      if (typeof a.ticket !== 'string' || !(TICKET.test(a.ticket.trim()) || LINEAR_URL.test(a.ticket.trim()))) {
        return 'start-ticket needs a ticket: KAR-123 or its Linear URL';
      }
      return ctx.projectPath ? null : 'this device has no KarmaSuite checkout (project.conf)';
    case 'new-session': {
      if (typeof a.dir !== 'string' || !isAbsolute(a.dir)) return 'new-session needs an absolute folder (dir)';
      const allowed = new Set([...(ctx.projectPath ? [ctx.projectPath] : []), ...ctx.worktrees()].map(real));
      return allowed.has(real(a.dir)) ? null : `${a.dir} is not the KarmaSuite checkout or one of its worktrees on this device`;
    }
    case 'restart-session':
      return typeof a.ticket === 'string' && TICKET.test(a.ticket.trim()) ? null : 'restart-session needs a ticket: KAR-123';
    case 'backup':
      return a.unit == null || (typeof a.unit === 'string' && UNIT.test(a.unit)) ? null : 'backup: unit must be a ticket or unit id';
  }
}

/** One program to run: a KS script by name (plugins/ks/scripts), or this daemon's backup CLI. */
export interface Step {
  kind: 'ks' | 'backup';
  name: string;
  args: string[];
  cwd?: string;
}

export interface StepResult {
  code: number | null;
  output: string;
}

export interface Outcome {
  status: Extract<DeviceCommandStatus, 'ok' | 'failed'>;
  message: string;
  output: string;
  exitCode: number | null;
}

/** The value of a `KEY=value` line ks-start-ticket --no-launch prints, or null. */
export function printed(output: string, key: string): string | null {
  const line = output.split('\n').reverse().find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() || null : null;
}

function lastLine(output: string): string {
  return (
    output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  );
}

export function tail(output: string): string {
  return output.length > OUTPUT_MAX ? `…${output.slice(-OUTPUT_MAX)}` : output;
}

/**
 * Run a checked command through `exec` (the daemon: the login shell's PATH, its
 * own node). `about`: this daemon's version and device name, for `ping`.
 */
export async function runCommand(
  doc: Pick<DeviceCommandDoc, 'command' | 'args'>,
  ctx: CommandContext,
  exec: (step: Step) => Promise<StepResult>,
  about: { version: string; device: string },
): Promise<Outcome> {
  const a = doc.args ?? {};
  const one = async (step: Step, ok: (r: StepResult) => string): Promise<Outcome> => {
    const r = await exec(step);
    return r.code === 0
      ? { status: 'ok', message: ok(r), output: tail(r.output), exitCode: 0 }
      : { status: 'failed', message: `${step.name} exited ${r.code ?? 'by a signal'}: ${lastLine(r.output) || 'no output'}`, output: tail(r.output), exitCode: r.code };
  };
  switch (doc.command) {
    case 'ping':
      return { status: 'ok', message: `ks-flow ${about.version} on ${about.device} answers`, output: '', exitCode: 0 };
    case 'start-ticket': {
      const ticket = a.ticket!.trim();
      const prep = await exec({ kind: 'ks', name: 'ks-start-ticket', args: [ticket, '--no-launch'], cwd: ctx.projectPath! });
      const worktree = printed(prep.output, 'KS_WORKTREE');
      const prompt = printed(prep.output, 'KS_PROMPT');
      if (!worktree || !prompt) {
        return {
          status: 'failed',
          message: `ks-start-ticket ${ticket} did not get as far as the worktree (exit ${prep.code ?? 'signal'}): ${lastLine(prep.output) || 'no output'}`,
          output: tail(prep.output),
          exitCode: prep.code,
        };
      }
      const open = await exec({ kind: 'ks', name: 'claude-ks-start', args: [worktree, prompt] });
      const both = `${prep.output}\n── claude-ks-start\n${open.output}`;
      return open.code === 0
        ? { status: 'ok', message: `${ticket}: a new session in its worktree ${worktree}, in a new window${prep.code ? ` (ks-start-ticket exited ${prep.code}: ${lastLine(prep.output)})` : ''}`, output: tail(both), exitCode: 0 }
        : { status: 'failed', message: `the worktree is ready (${worktree}), but claude-ks-start exited ${open.code ?? 'by a signal'}: ${lastLine(open.output) || 'no output'}`, output: tail(both), exitCode: open.code };
    }
    case 'new-session':
      return one({ kind: 'ks', name: 'claude-ks-start', args: [a.dir!] }, () => `a new session in ${a.dir}, in a new window`);
    case 'restart-session':
      return one({ kind: 'ks', name: 'claude-ks-restart', args: [a.ticket!.trim().toUpperCase()] }, (r) => lastLine(r.output) || `${a.ticket} restarted`);
    case 'backup':
      return one({ kind: 'backup', name: 'transcript-backup', args: a.unit ? ['--unit', a.unit] : [] }, (r) => lastLine(r.output) || 'backed up');
  }
}

/**
 * This device's commands as the listener delivers them: run each queued one
 * once (in order, one at a time), expire stale ones, mark ones left `running`
 * by an earlier daemon as interrupted, and delete finished ones after 30 days.
 */
export class DeviceCommandQueue {
  /** uids handled (or being handled) by this daemon. */
  private seen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Pick<DeviceStore, 'claimDeviceCommand' | 'updateDeviceCommand' | 'deleteDeviceCommand'>,
    private run: (doc: DeviceCommandDoc) => Promise<Outcome>,
    private refuse: (doc: DeviceCommandDoc) => string | null,
    private log: (msg: string) => void,
    private now: () => number = Date.now,
  ) {}

  take(list: DeviceCommandDoc[]): Promise<unknown> {
    const next = this.chain.then(() => this.pass(list));
    this.chain = next.catch(() => {});
    return next;
  }

  private async pass(list: DeviceCommandDoc[]): Promise<void> {
    const now = this.now();
    const iso = (): string => new Date(this.now()).toISOString();
    for (const doc of [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (!doc.uid) continue;
      const age = now - Date.parse(doc.createdAt);
      if (doc.status !== 'queued' && doc.status !== 'running') {
        const done = Date.parse(doc.endedAt ?? doc.createdAt);
        if (Number.isFinite(done) && now - done > KEEP_MS) await this.store.deleteDeviceCommand?.(doc.uid).catch(() => {});
        continue;
      }
      if (this.seen.has(doc.uid)) continue;
      this.seen.add(doc.uid);
      if (doc.status === 'running') {
        // Not this daemon's (it would be in `seen`): an earlier daemon died while it ran.
        await this.finish(doc, { status: 'failed', message: 'interrupted: ks-flow restarted while it ran; its outcome is unknown', output: '', exitCode: null }, iso());
        continue;
      }
      if (!(age <= EXPIRE_MS)) {
        await this.store.updateDeviceCommand?.(doc.uid, { status: 'expired', endedAt: iso(), message: `not run: asked ${Number.isFinite(age) ? Math.round(age / 60_000) : '?'} min ago (commands expire after 15 min)` });
        this.log(`commands: ${doc.command} from ${doc.from?.by ?? '?'} expired`);
        continue;
      }
      const why = this.refuse(doc);
      if (why) {
        await this.store.updateDeviceCommand?.(doc.uid, { status: 'refused', endedAt: iso(), message: why });
        this.log(`commands: ${doc.command} from ${doc.from?.by ?? '?'} refused: ${why}`);
        continue;
      }
      const claimed = this.store.claimDeviceCommand ? await this.store.claimDeviceCommand(doc.uid, iso()).catch(() => false) : true;
      if (!claimed) continue; // another run of this daemon took it, or it changed meanwhile
      this.log(`commands: running ${doc.command} ${JSON.stringify(doc.args ?? {})} from ${doc.from?.by ?? '?'}`);
      let out: Outcome;
      try {
        out = await this.run(doc);
      } catch (e) {
        out = { status: 'failed', message: `could not run: ${(e as Error)?.message ?? e}`, output: '', exitCode: null };
      }
      await this.finish(doc, out, iso());
      this.log(`commands: ${doc.command} ${out.status}: ${out.message}`);
    }
  }

  private async finish(doc: DeviceCommandDoc, out: Outcome, endedAt: string): Promise<void> {
    await this.store
      .updateDeviceCommand?.(doc.uid, { status: out.status, endedAt, message: out.message, output: out.output || null, exitCode: out.exitCode })
      .catch((e) => this.log(`commands: outcome of ${doc.uid} not written (${(e as Error)?.message})`));
  }
}
