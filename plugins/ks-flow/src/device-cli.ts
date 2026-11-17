#!/usr/bin/env node
// device-cli.ts — this device and the cards' owners (one ks-flow board for
// several devices):
//
//   ks-flow device-id [--json]          this device's id (KS_DEVICE_ID, else the
//                                       stored ks.KS_DEVICE_ID, else the daemon's
//                                       device.json, else generated); --json:
//     { deviceId, defaultName, source: env | config | hardware | hostname | device.json,
//       hardwareMatches: the id is this machine's hardware id (null: none) }
//   ks-flow card-owner <unit> [--json]  which device a card is on:
//     { unitId, exists, deviceId, device, self, selfName, local,
//       ownerHasWorktree, ownerHasLiveSession, ownerLastSeenAt, ownerForgotten,
//       decision: none | refuse | move, message }
//   ks-flow card-move <unit> [--json]   move the card to this device, when its
//                                       owner no longer has its worktree or a
//                                       live session (else refuse)
//   ks-flow devices [--json] [--live]   every device on the board (this device
//                                       first, then by label), from the daemon's
//                                       cache <dataDir>/devices.json (instant,
//                                       offline; the store when it is missing),
//                                       or from the store with --live; --json:
//     { source: cache | store, updatedAt: the cache's last store read (store: now),
//       self: <this deviceId>,
//       devices: [{ label, name, deviceId, lastSeenAt, self, master, forgotten,
//                   stale (not seen for 5 min, against now), sessions }] }
//   ks-flow peers [--md|--json]         every running Claude session on every
//                                       device (lib/peers.ts): device, peer name,
//                                       ticket and title, state (working, idle,
//                                       waiting on you, last seen …), address
//                                       (bridge:<Remote Control id>), tmux pane,
//                                       started; from the store, the daemon's
//                                       cache when the store can't answer.
//                                       --md: a Markdown table; --json:
//     { source: store | cache, updatedAt, self,
//       rows: [{ device: { deviceId, label, name, self, stale, lastSeenAt },
//                session: PeerSession | null (a device with none), state,
//                address, you (this is the asking session: $CLAUDE_PID) }] }
//   ks-flow device-run <device> <command> [<ticket|dir|unit>] [--from <who>]
//                      [--note <why>] [--wait [<seconds>]] [--json]
//                                       the message board (lib/device-commands.ts):
//                                       ask <device>'s daemon (its label A/B, name,
//                                       id, or "self") to run one command: ping,
//                                       start-ticket <KAR-123|URL>, new-session
//                                       <absolute dir on that device>,
//                                       restart-session <KAR-123>, backup [<unit>].
//                                       --from: who asks (your peer name;
//                                       default $KS_COMMAND_FROM, else "cli").
//                                       --wait: until it finishes (default 180 s)
//                                       and print the outcome. Firestore only.
//   ks-flow commands [--limit <n>] [--json]   the newest commands on the board
//
// Exit: 0 answered / moved / nothing to move / the command ran (or was posted);
// 1 card-move refused, or the command failed, was refused or expired; 2 usage,
// or the store can't answer; 3 --wait ran out while it was still queued or running.
import { dataDir, loadConfig } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import { deviceIdentity, resolveDeviceId } from './lib/device.js';
import { cardOwner, moveCard, startDecision } from './lib/card-owner.js';
import { agoText, formatDevices, listDevices, readDevicesCache, refreshRows } from './lib/device-list.js';
import { formatPeers, formatPeersMarkdown, peerRows, type PeerRow } from './lib/peers.js';
import { randomUUID } from 'node:crypto';
import { COMMANDS, isCommandName } from './lib/device-commands.js';
import type { DeviceCommandDoc, DeviceDoc } from './lib/db/types.js';

const READ_TIMEOUT_MS = 10_000;

function fail(code: number, msg: string): never {
  console.error(`ks-flow: ${msg}`);
  process.exit(code);
}

function timed<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS).unref()),
  ]);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  const unit = rest.find((a) => !a.startsWith('-'));
  loadConfig(); // <dataDir>/.env first: a KS_DEVICE_ID pinned there must name this device
  const self = deviceIdentity(dataDir());

  if (cmd === 'device-id') {
    if (json) {
      const r = resolveDeviceId();
      const source = r.deviceId === self.deviceId ? r.source : 'device.json';
      const hardwareMatches = r.hardwareId ? r.hardwareId === self.deviceId : null;
      console.log(JSON.stringify({ ...self, source, hardwareMatches }));
    } else console.log(self.deviceId);
    process.exit(0);
  }
  if (cmd === 'devices') {
    const now = Date.now();
    const cache = rest.includes('--live') ? null : readDevicesCache(dataDir());
    let out: { source: 'cache' | 'store'; updatedAt: string; self: string; devices: ReturnType<typeof listDevices> };
    if (cache) {
      out = { source: 'cache', updatedAt: cache.updatedAt, self: self.deviceId, devices: refreshRows(cache.devices, self.deviceId, now) };
    } else {
      const store = createProvider(loadConfig()).devices();
      try {
        const [devices, settings] = await timed(Promise.all([store.getDevices(), store.getSettings()]));
        const list = listDevices(devices, self.deviceId, settings?.masterDeviceId ?? null, now);
        out = { source: 'store', updatedAt: new Date(now).toISOString(), self: self.deviceId, devices: list };
      } catch (e) {
        fail(2, `can't read the store (${(e as Error).message})`);
      }
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(formatDevices(out.devices, now, out.source === 'cache' ? out.updatedAt : null));
    process.exit(0);
  }
  if (cmd === 'peers') {
    const now = Date.now();
    const pid = Number(process.env.CLAUDE_PID);
    const callerPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    let source: 'store' | 'cache' = 'store';
    let updatedAt = new Date(now).toISOString();
    let rows: PeerRow[];
    try {
      const devices = await timed(createProvider(loadConfig()).devices().getDevices());
      rows = peerRows(devices, self.deviceId, now, callerPid);
    } catch (e) {
      const cache = readDevicesCache(dataDir());
      if (!cache) fail(2, `can't read the store (${(e as Error).message}) and the daemon has no devices cache yet`);
      source = 'cache';
      updatedAt = cache.updatedAt;
      rows = peerRows(cache.devices, self.deviceId, now, callerPid);
    }
    if (json) console.log(JSON.stringify({ source, updatedAt, self: self.deviceId, rows }, null, 2));
    else if (rest.includes('--md')) {
      console.log(formatPeersMarkdown(rows, now));
      if (source === 'cache') console.log(`\n(as of ${agoText(updatedAt, now)}: the daemon's cache, the store could not be read)`);
    } else console.log(formatPeers(rows, now, source === 'cache' ? updatedAt : null));
    process.exit(0);
  }
  if (cmd === 'device-run') return deviceRun(rest, self.deviceId, json);
  if (cmd === 'commands') return listCommands(rest, self.deviceId, json);
  if (cmd !== 'card-owner' && cmd !== 'card-move') fail(2, 'usage: device-cli.js {device-id|devices|peers|device-run|commands|card-owner <unit>|card-move <unit>} [--json]');
  if (!unit) fail(2, `usage: ks-flow ${cmd} <unit> [--json]`);

  const store = createProvider(loadConfig()).devices();
  if (cmd === 'card-owner') {
    let info;
    try {
      info = await timed(cardOwner(store, self, unit));
    } catch (e) {
      fail(2, `can't read the store (${(e as Error).message})`);
    }
    const d = startDecision(info);
    if (json) console.log(JSON.stringify({ ...info, decision: d.action, message: d.message }, null, 2));
    else console.log(d.message);
    process.exit(0);
  }

  let res;
  try {
    res = await timed(moveCard(store, self, unit));
  } catch (e) {
    fail(2, `can't move the card (${(e as Error).message})`);
  }
  const refused = !res.moved && startDecision(res.info).action === 'refuse';
  if (json) console.log(JSON.stringify({ moved: res.moved, refused, message: res.message, ...res.info }, null, 2));
  else console.log(res.message);
  process.exit(refused ? 1 : 0);
}

/** The value after a flag, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

/** Positional arguments (flags and their values left out). */
function positional(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

/** A device by its label (A), id (or 6+ leading characters), name, or "self". */
function findDevice(devices: DeviceDoc[], key: string, self: string): DeviceDoc | null {
  const k = key.trim().toLowerCase();
  if (k === 'self' || k === 'this' || k === 'here') return devices.find((d) => d.deviceId === self) ?? null;
  const live = devices.filter((d) => !d.forgotten);
  return (
    live.find((d) => (d.label ?? '').toLowerCase() === k) ??
    live.find((d) => d.deviceId === key || (k.length >= 6 && d.deviceId.startsWith(k))) ??
    live.find((d) => (d.name ?? '').toLowerCase() === k || (d.defaultName ?? '').toLowerCase() === k) ??
    null
  );
}

const TERMINAL = new Set(['ok', 'failed', 'refused', 'expired']);

function describe(c: DeviceCommandDoc, names: Map<string, string>): string {
  const arg = c.args?.ticket ?? c.args?.dir ?? c.args?.unit ?? '';
  const to = names.get(c.to) ?? c.to.slice(0, 8);
  return `${c.createdAt.slice(0, 16).replace('T', ' ')}  ${c.from?.by ?? '?'} → ${to}: ${c.command}${arg ? ` ${arg}` : ''}  [${c.status}]${c.message ? ` ${c.message}` : ''}`;
}

async function deviceRun(rest: string[], selfId: string, json: boolean): Promise<void> {
  const valued = ['--from', '--note', '--wait'];
  const [deviceKey, command, arg] = positional(rest, valued);
  if (!deviceKey || !command) {
    fail(2, `usage: ks-flow device-run <device> <command> [<ticket|dir|unit>] [--from <who>] [--note <why>] [--wait [<s>]] [--json]\ncommands:\n${Object.entries(COMMANDS).map(([n, d]) => `  ${n.padEnd(16)} ${d}`).join('\n')}`);
  }
  if (!isCommandName(command)) fail(2, `unknown command "${command}" (one of: ${Object.keys(COMMANDS).join(', ')})`);
  const store = createProvider(loadConfig()).devices();
  if (!store.addDeviceCommand || !store.watchDeviceCommand) fail(2, 'the message board needs the Firestore store');
  let devices: DeviceDoc[];
  try {
    devices = await timed(store.getDevices());
  } catch (e) {
    fail(2, `can't read the store (${(e as Error).message})`);
  }
  const target = findDevice(devices, deviceKey, selfId);
  if (!target) fail(2, `no device "${deviceKey}" (devices: ${devices.filter((d) => !d.forgotten).map((d) => `${d.label ?? '?'} ${d.name || d.defaultName}`).join(', ')})`);
  const args: DeviceCommandDoc['args'] = {};
  if (command === 'start-ticket' || command === 'restart-session') {
    if (!arg) fail(2, `${command} needs a ticket (KAR-123)`);
    args.ticket = arg;
  } else if (command === 'new-session') {
    if (!arg) fail(2, 'new-session needs an absolute folder on that device');
    args.dir = arg;
  } else if (command === 'backup' && arg) args.unit = arg;
  const doc: DeviceCommandDoc = {
    uid: randomUUID(),
    to: target.deviceId,
    from: { deviceId: selfId, by: flag(rest, '--from') || process.env.KS_COMMAND_FROM || 'cli' },
    command,
    args,
    note: flag(rest, '--note') ?? null,
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  try {
    await timed(store.addDeviceCommand!(doc));
  } catch (e) {
    fail(2, `can't post the command (${(e as Error).message})`);
  }
  const name = `${target.label ? `${target.label} · ` : ''}${target.name || target.defaultName || target.deviceId}`;
  if (!rest.includes('--wait')) {
    if (json) console.log(JSON.stringify({ posted: true, ...doc }, null, 2));
    else console.log(`posted ${command}${arg ? ` ${arg}` : ''} for ${name} (${doc.uid}); ks-flow commands shows its outcome`);
    process.exit(0);
  }
  const secs = Number(flag(rest, '--wait') ?? 180);
  const waitMs = (Number.isFinite(secs) && secs > 0 ? secs : 180) * 1000;
  let last: DeviceCommandDoc = doc;
  const done = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, waitMs);
    const stop = store.watchDeviceCommand!(
      doc.uid,
      (c) => {
        if (!c) return;
        last = c;
        if (TERMINAL.has(c.status)) {
          clearTimeout(timer);
          stop();
          resolve(true);
        }
      },
      () => {},
    );
  });
  if (json) console.log(JSON.stringify({ finished: done, ...last }, null, 2));
  else if (done) console.log(`${name}: ${command} ${last.status}: ${last.message ?? ''}`);
  else console.log(`${name}: ${command} still ${last.status} after ${waitMs / 1000}s (${doc.uid}); ks-flow commands shows it when it ends`);
  process.exit(!done ? 3 : last.status === 'ok' ? 0 : 1);
}

async function listCommands(rest: string[], selfId: string, json: boolean): Promise<void> {
  const limit = Math.max(1, Math.min(200, Number(flag(rest, '--limit') ?? 20) || 20));
  const cfg = loadConfig();
  const provider = createProvider(cfg);
  const db = provider.docDb?.();
  if (!db) fail(2, 'the message board needs the Firestore store');
  let cmds: DeviceCommandDoc[];
  let devices: DeviceDoc[];
  try {
    [cmds, devices] = await timed(
      Promise.all([
        db.list('deviceCommands').then((l) => l.map((d) => ({ ...(d.data as unknown as DeviceCommandDoc), uid: d.id }))),
        provider.devices().getDevices(),
      ]),
    );
  } catch (e) {
    fail(2, `can't read the store (${(e as Error).message})`);
  }
  cmds.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  cmds = cmds.slice(0, limit);
  if (json) {
    console.log(JSON.stringify({ self: selfId, commands: cmds }, null, 2));
    process.exit(0);
  }
  const names = new Map(devices.map((d) => [d.deviceId, d.label ?? (d.name || d.defaultName || d.deviceId.slice(0, 8))]));
  console.log(cmds.length ? cmds.map((c) => describe(c, names)).join('\n') : 'no commands yet');
  process.exit(0);
}

main().catch((e) => fail(2, (e as Error).message));
