#!/usr/bin/env node
// store-check.ts — one line per fact about the store, for `ks-flow status`:
// which provider the daemon resolves, whether it answers (one read of
// meta/settings, 8 s cap), whether the store is set up for devices (that
// read's answer, and this device's id), how many devices share it (not
// forgotten; ks-setup suggests Remote Control from 2), and, with Firestore, how
// many writes wait in the offline outbox.
//   node dist/store-check.js [--json]
import { join } from 'node:path';
import { dataDir, loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import { outboxCount } from './lib/db/outbox.js';
import { deviceIdentity } from './lib/device.js';

const TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const conf = readProjectConf();
  const where =
    cfg.dbProvider === 'firestore'
      ? `${cfg.firestoreMode === 'cloud' ? cfg.gcpProjectId : 'emulator'}`
      : cfg.pocketbaseUrl;
  let ok = false;
  let error = '';
  let masterDeviceId: string | null = null;
  let devicesSetUp = false;
  let name: string | null = null;
  let deviceCount: number | null = null;
  const self = deviceIdentity(dataDir());
  if (conf) {
    try {
      const devices = createProvider(cfg).devices();
      const read = devices.getSettings();
      const settings = await Promise.race([
        read,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
      ]);
      ok = true;
      devicesSetUp = !!settings;
      masterDeviceId = settings?.masterDeviceId ?? null;
      if (devicesSetUp) {
        // The name chosen in Settings → Devices (the doctor shows it beside the id).
        const dev = await Promise.race([
          devices.getDevice(self.deviceId),
          new Promise<null>((res) => setTimeout(() => res(null), TIMEOUT_MS).unref()),
        ]).catch(() => null);
        name = dev?.name || null;
        const all = await Promise.race([
          devices.getDevices(),
          new Promise<null>((res) => setTimeout(() => res(null), TIMEOUT_MS).unref()),
        ]).catch(() => null);
        deviceCount = all ? all.filter((d) => !d.forgotten).length : null;
      }
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    error = 'no project.conf';
  }
  const pending = cfg.dbProvider === 'firestore' ? outboxCount(join(dataDir(), 'outbox')) : 0;
  const failed = cfg.dbProvider === 'firestore' ? outboxCount(join(dataDir(), 'outbox', 'failed')) : 0;
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        provider: cfg.dbProvider,
        where,
        ok,
        error: error || undefined,
        pending,
        failed,
        deviceId: self.deviceId,
        device: self.defaultName,
        name: name ?? undefined,
        devicesSetUp: ok ? devicesSetUp : undefined,
        masterDeviceId: masterDeviceId ?? undefined,
        devices: deviceCount ?? undefined,
      }),
    );
    return;
  }
  console.log(`  ${cfg.dbProvider} (${where}): ${ok ? 'reachable' : `NOT reachable — ${error}`}`);
  console.log(`  this device: ${self.deviceId} (${name ?? self.defaultName})`);
  if (ok) {
    console.log(
      devicesSetUp
        ? `  devices: set up${deviceCount != null ? `, ${deviceCount} device(s)` : ''} (master device ${masterDeviceId}${masterDeviceId === self.deviceId ? ', this one' : ''})`
        : '  devices: NOT set up — run the one-time backfill (plugins/ks-flow/scripts/one-off/backfill-devices.ts)',
    );
  }
  if (cfg.dbProvider === 'firestore') {
    console.log(`  offline outbox: ${pending} write(s) waiting to sync${failed ? `, ${failed} refused (outbox/failed/)` : ''}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`  store check failed: ${(e as Error).message}`);
    process.exit(0);
  });
