// session-info.ts — `ks-flow session [<unit>] [--json]`: which Claude Code
// process is working a unit's worktree right now, as the daemon recorded it.
//
//   ks-flow session KAR-123 --json
//     { unitId, worktreeDir, workflowDir, activeSession, liveSessions }
//     activeSession: { pid, sessionId, cwd, procStart, startedAt, tmuxPane, name } | null
//   ks-flow session            every unit with a live session, one per line
//
// Exit: 0 found; 1 unknown unit, or no live session for it; 2 usage, or the
// store or daemon can't answer. The record trails reality by up to one daemon
// tick (15 s): a caller about to signal the pid re-checks it against `ps` first.
import { dirname } from 'node:path';
import { loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import type { WorkUnitDoc } from './lib/db/types.js';

function fail(code: number, msg: string): never {
  console.error(`ks-flow session: ${msg}`);
  process.exit(code);
}

function summary(u: WorkUnitDoc) {
  return {
    unitId: u.unitId,
    worktreeDir: u.worktreeDir,
    workflowDir: dirname(u.stateYamlPath),
    activeSession: u.activeSession ?? null,
    liveSessions: u.liveSessions ?? [],
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const unitId = argv.find((a) => !a.startsWith('-'));

  const conf = readProjectConf();
  if (!conf) fail(2, 'no project.conf — run `ks-flow start` first');
  let units: WorkUnitDoc[];
  try {
    units = await createProvider(loadConfig()).source().getWorkUnits(conf.projectId);
  } catch (e) {
    fail(2, `can't read the store (${(e as Error).message}) — is the daemon running? \`ks-flow start\``);
  }
  // A daemon built before live-session tracking never writes the field.
  if (units.length && units.every((u) => u.liveSessions === undefined)) {
    fail(2, 'the running daemon predates live-session tracking — run `ks-flow start` to rebuild it');
  }

  if (!unitId) {
    const live = units.filter((u) => u.activeSession).map(summary);
    if (json) console.log(JSON.stringify(live, null, 2));
    else
      for (const u of live)
        console.log(`${u.unitId}\tpid ${u.activeSession!.pid}\t${u.activeSession!.tmuxPane ?? '-'}\t${u.worktreeDir}`);
    process.exit(0);
  }

  const unit = units.find((u) => u.unitId.toLowerCase() === unitId.toLowerCase());
  if (!unit) fail(1, `no unit ${unitId} on the board`);
  const out = summary(unit);
  if (json) console.log(JSON.stringify(out, null, 2));
  else if (out.activeSession)
    console.log(
      `${out.unitId}: pid ${out.activeSession.pid}, session ${out.activeSession.sessionId}, ` +
        `tmux ${out.activeSession.tmuxPane ?? '-'}, in ${out.activeSession.cwd}`,
    );
  else console.log(`${out.unitId}: no live session`);
  process.exit(out.activeSession ? 0 : 1);
}

main().catch((e) => fail(2, (e as Error).message));
