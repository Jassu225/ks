#!/usr/bin/env node
/**
 * ks-time — active time spent on a ks workflow unit (ticket or project).
 *
 * Reads the log time-log.sh writes (~/.claude/ks-time/<identifier>.jsonl) and
 * prints engaged and agent time, by phase and by day. See lib/time-tracking.ts
 * for what counts.
 *
 *   ks-time                 the unit this checkout belongs to
 *   ks-time KAR-123         a unit by identifier
 *   ks-time --all           every logged unit, most recent first
 *   ks-time --idle 15       a different idle cut-off, in minutes
 *   ks-time --write         also write the figures into this checkout's
 *                           state.yaml (phases[].engaged_minutes, time_spent);
 *                           the time-log.sh hook runs this on Stop and SessionEnd
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';

import { withTimeSpent } from './lib/state-time.js';
import { DEFAULT_IDLE_MS, formatDuration, parseLog, summarize } from './lib/time-tracking.js';
import type { TimeSummary } from './lib/time-tracking.js';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// `ks-time --all | head`: a reader that stops early is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
const LOG_DIR = process.env.KS_TIME_DIR || join(homedir(), '.claude', 'ks-time');

const PHASE_LABELS: Record<string, string> = {
  '1': 'Context',
  '2': 'Research',
  '3': 'PRD draft',
  '4': 'Stories',
  '5': 'Prototype',
  '6': 'PRD',
  '7': 'TAD',
  '8': 'Tickets',
  '9': 'Plan',
  '10': 'Implement',
  '-': 'No phase',
};

/** The rule time-log.sh and ks-flow's safeId() apply to a file name. */
function safeId(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The unit this checkout belongs to, as time-log.sh names it, and its state.yaml. */
function currentUnit(): { id: string; stateFile: string } | null {
  const run = spawnSync(join(SCRIPTS_DIR, 'workflow-unit'), { encoding: 'utf8' });
  if (run.status !== 0 || !run.stdout.trim()) return null;
  const [stateFile = '', , id] = run.stdout.trim().split('\t');
  return { id: id && id !== '-' ? id : basename(dirname(stateFile)), stateFile };
}

/** `now`: count a session still going up to it (the screen); left out, only what the events close (the file). */
function load(identifier: string, idleMs: number, now?: number): TimeSummary | null {
  const file = join(LOG_DIR, `${safeId(identifier)}.jsonl`);
  if (!existsSync(file)) return null;
  return summarize(parseLog(readFileSync(file, 'utf8')), idleMs, now);
}

/** Writes the figures into state.yaml when they changed; tmp + rename, so a reader never sees half a file. */
function writeState(stateFile: string, summary: TimeSummary): boolean {
  const next = withTimeSpent(readFileSync(stateFile, 'utf8'), summary, new Date().toISOString());
  if (next === null) return false;
  const tmp = `${stateFile}.ks-time.tmp`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, stateFile);
  return true;
}

function when(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function printUnit(identifier: string, s: TimeSummary): void {
  const pad = (text: string, n: number): string => text.padEnd(n);
  console.log(chalk.bold(`\n${identifier}`));
  console.log(`  ${pad('Engaged', 10)}${chalk.bold(formatDuration(s.engagedMs))}  ${chalk.dim(`(gaps over ${s.idleMs / 60_000}m count as away)`)}`);
  console.log(`  ${pad('Agent', 10)}${formatDuration(s.agentMs)}`);
  console.log(chalk.dim(`  ${s.sessions} session(s) · ${when(s.firstAt)} → ${when(s.lastAt)}`));

  const phases = Object.entries(s.byPhase).sort(([a], [b]) => (a === '-' ? 99 : Number(a)) - (b === '-' ? 99 : Number(b)));
  if (phases.length > 0) {
    console.log(chalk.bold('\n  By phase'));
    for (const [phase, f] of phases) {
      const label = `${phase === '-' ? '' : `${phase} `}${PHASE_LABELS[phase] ?? `Phase ${phase}`}`;
      console.log(`  ${pad(label, 16)}${pad(formatDuration(f.engagedMs), 9)}${chalk.dim(`agent ${formatDuration(f.agentMs)}`)}`);
    }
  }
  const days = Object.entries(s.byDay);
  if (days.length > 0) {
    console.log(chalk.bold('\n  By day'));
    for (const [day, f] of days) {
      console.log(`  ${pad(day, 16)}${pad(formatDuration(f.engagedMs), 9)}${chalk.dim(`agent ${formatDuration(f.agentMs)}`)}`);
    }
  }
  console.log();
}

const program = new Command()
  .name('ks-time')
  .description('Active time spent on a ks workflow unit, from the hooks time log')
  .argument('[identifier]', 'unit identifier (KAR-123, or a project workflow folder); default: this checkout\'s unit')
  .option('--idle <minutes>', 'gaps longer than this count as time away', String(DEFAULT_IDLE_MS / 60_000))
  .option('--all', 'every logged unit, most recent first')
  .option('--json', 'machine-readable output')
  .option('--write', "write the figures into this checkout's state.yaml (no output)")
  .action((identifier: string | undefined, opts: { idle: string; all?: boolean; json?: boolean; write?: boolean }) => {
    const idleMinutes = Number(opts.idle);
    if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
      console.error(chalk.red(`--idle must be a positive number of minutes, got ${opts.idle}`));
      process.exit(1);
    }
    const idleMs = idleMinutes * 60_000;

    if (opts.all) {
      const units = (existsSync(LOG_DIR) ? readdirSync(LOG_DIR) : [])
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const id = f.slice(0, -'.jsonl'.length);
          return { id, summary: load(id, idleMs, Date.now()) };
        })
        .filter((u): u is { id: string; summary: TimeSummary } => u.summary !== null)
        .sort((a, b) => (b.summary.lastAt ?? 0) - (a.summary.lastAt ?? 0));
      if (opts.json) {
        console.log(JSON.stringify(Object.fromEntries(units.map(u => [u.id, u.summary])), null, 2));
        return;
      }
      if (units.length === 0) {
        console.log(`No time logged yet (${LOG_DIR}).`);
        return;
      }
      for (const { id, summary } of units) {
        console.log(`${id.padEnd(28)}${formatDuration(summary.engagedMs).padEnd(10)}${chalk.dim(`agent ${formatDuration(summary.agentMs).padEnd(9)} last ${when(summary.lastAt)}`)}`);
      }
      return;
    }

    if (opts.write) {
      // Only this checkout's own state.yaml: the one whose worktree_dir is here.
      const unit = currentUnit();
      if (!unit) {
        console.error(chalk.red('Not in a ks workflow checkout: --write needs the unit that owns this checkout'));
        process.exit(1);
      }
      // What the events close, not up to now: the file records finished time.
      const summary = load(unit.id, idleMs);
      if (summary) writeState(unit.stateFile, summary);
      return;
    }

    const id = identifier ?? currentUnit()?.id;
    if (!id) {
      console.error(chalk.red('Not in a ks workflow checkout; name the unit: ks-time KAR-123'));
      process.exit(1);
    }
    // Counted up to now: a session still going shows its running turn.
    const summary = load(id, idleMs, Date.now());
    if (!summary) {
      console.error(chalk.yellow(`No time logged for ${id} yet (${join(LOG_DIR, `${safeId(id)}.jsonl`)}).`));
      process.exit(1);
    }
    if (opts.json) console.log(JSON.stringify({ identifier: id, ...summary }, null, 2));
    else printUnit(id, summary);
  });

program.parse();
