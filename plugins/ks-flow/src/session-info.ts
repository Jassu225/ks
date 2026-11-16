// session-info.ts — `ks-flow session [<unit>] [--json]`: which Claude Code
// process is working a unit's worktree right now, as the daemon recorded it.
//
//   ks-flow session KAR-123 --json
//     { unitId, worktreeDir, workflowDir, activeSession, liveSessions,
//       deviceId, device, local }
//     activeSession: { pid, sessionId, cwd, procStart, startedAt, tmuxPane, name } | null
//     deviceId/device: the card's owner device (id, name); local: it is this one
//   ks-flow session            every unit with a live session, one per line
//
// A card on another device: its pid and tmux pane are that device's, so the
// plain output says "on <name>" and the exit is 1, as for no live session
// here (--json still prints the record, local: false).
//
// Exit: 0 found on this device; 1 unknown unit, no live session for it, or it
// is on another device; 2 usage, or the store or daemon can't answer. The record trails reality by up to one daemon
// tick (15 s): a caller about to signal the pid re-checks it against `ps` first.
import { dirname } from 'node:path';
import { dataDir, loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import type { DeviceDoc, WorkUnitDoc } from './lib/db/types.js';
import { deviceId } from './lib/device.js';
import { deviceName } from './lib/card-owner.js';

function fail(code: number, msg: string): never {
  console.error(`ks-flow session: ${msg}`);
  process.exit(code);
}

// <dataDir>/.env first: a KS_DEVICE_ID pinned there must name this device.
loadConfig();
const SELF = deviceId(dataDir());
let devices = new Map<string, DeviceDoc>();

function summary(u: WorkUnitDoc) {
  const owner = u.deviceId ?? null;
  return {
    unitId: u.unitId,
    worktreeDir: u.worktreeDir,
    workflowDir: dirname(u.stateYamlPath),
    activeSession: u.activeSession ?? null,
    liveSessions: u.liveSessions ?? [],
    deviceId: owner,
    device: owner ? deviceName(devices.get(owner), owner) : null,
    // A card with no owner yet (before the device backfill) is this device's.
    local: !owner || owner === SELF,
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
    const provider = createProvider(loadConfig());
    const [list, devs] = await Promise.all([
      provider.source().getWorkUnits(conf.projectId),
      provider.devices().getDevices().catch(() => [] as DeviceDoc[]),
    ]);
    units = list;
    devices = new Map(devs.map((d) => [d.deviceId, d]));
  } catch (e) {
    fail(2, `can't read the store (${(e as Error).message}) — is the daemon running? \`ks-flow start\``);
  }
  // A daemon built before live-session tracking never writes the field.
  if (units.length && units.every((u) => u.liveSessions === undefined)) {
    fail(2, 'the running daemon predates live-session tracking — run `ks-flow start` to rebuild it');
  }

  if (!unitId) {
    // This device's live sessions only: another device's pid means nothing here.
    const live = units.filter((u) => u.activeSession).map(summary).filter((u) => u.local);
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
  else if (!out.local) console.log(`${out.unitId}: on ${out.device}`);
  else if (out.activeSession)
    console.log(
      `${out.unitId}: pid ${out.activeSession.pid}, session ${out.activeSession.sessionId}, ` +
        `tmux ${out.activeSession.tmuxPane ?? '-'}, in ${out.activeSession.cwd}`,
    );
  else console.log(`${out.unitId}: no live session`);
  process.exit(out.local && out.activeSession ? 0 : 1);
}

main().catch((e) => fail(2, (e as Error).message));
