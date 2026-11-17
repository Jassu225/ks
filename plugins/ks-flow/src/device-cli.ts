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
//
// Exit: 0 answered / moved / nothing to move; 1 card-move refused; 2 usage,
// or the store can't answer.
import { dataDir, loadConfig } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import { deviceIdentity, resolveDeviceId } from './lib/device.js';
import { cardOwner, moveCard, startDecision } from './lib/card-owner.js';
import { agoText, formatDevices, listDevices, readDevicesCache, refreshRows } from './lib/device-list.js';
import { formatPeers, formatPeersMarkdown, peerRows, type PeerRow } from './lib/peers.js';

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
  if (cmd !== 'card-owner' && cmd !== 'card-move') fail(2, 'usage: device-cli.js {device-id|devices|peers|card-owner <unit>|card-move <unit>} [--json]');
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

main().catch((e) => fail(2, (e as Error).message));
