// scripts/one-off/retag-device.ts — move everything a wrong device id owns to
// this device, then delete that id's devices/{id} record. For a daemon that
// ran under a wrong id (the 0.2.0 dev build fell back to the host-name id
// under launchd), never to merge two real devices.
//
//   cd plugins/ks-flow/src && npx tsx ../scripts/one-off/retag-device.ts --from <wrong id> [--dry-run] [--data-dir D] [--json]
//
// Stop the daemon first (`ks-flow stop`) and wait 3 minutes: the run refuses
// while the wrong id still sends heartbeats. This device's id is the stored
// ks.KS_DEVICE_ID (or KS_DEVICE_ID), else its hardware id. Logic:
// src/lib/device-retag.ts. Exit: 0 done (or dry run), 1 refused, 2 error.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<number> {
  const from = arg('--from');
  if (!from) {
    console.error('usage: retag-device.ts --from <wrong device id> [--dry-run] [--data-dir D] [--json]');
    return 2;
  }
  const { pickDataDir } = await import('../../src/lib/pick-datadir.js');
  const picked = pickDataDir({ flag: arg('--data-dir') });
  if (picked.ambiguous) console.error(`several ks-flow projects are configured: using ${picked.dir}. Pass --data-dir <dir> to choose.`);
  process.env.KS_FLOW_DATA = picked.dir;
  const { loadConfig } = await import('../../src/lib/config.js');
  const { createProvider } = await import('../../src/lib/db/index.js');
  const { resolveDeviceId } = await import('../../src/lib/device.js');
  const { retagDevice } = await import('../../src/lib/device-retag.js');

  const cfg = loadConfig();
  if (cfg.dbProvider !== 'firestore') {
    console.error(`the store is ${cfg.dbProvider}: nothing to do`);
    return 1;
  }
  // Not device.json: that is what the wrong id was written to.
  const self = resolveDeviceId();
  if (self.source === 'hostname') {
    console.error('this machine has no hardware id and nothing is stored: set ks.KS_DEVICE_ID first');
    return 1;
  }
  const db = createProvider(cfg).docDb?.();
  if (!db) throw new Error('this store has no path-level access');
  const dryRun = has('--dry-run');
  const res = await retagDevice(db, { from, to: self.deviceId, dryRun, log: (m) => console.error(`  ${m}`) });
  if (has('--json')) {
    console.log(JSON.stringify({ from, to: self.deviceId, source: self.source, ...res }, null, 2));
  } else if (res.refused) {
    console.log(`refused: ${res.refused}`);
  } else {
    const verb = dryRun ? 'would move' : 'moved';
    console.log(`${from} → ${self.deviceId} (this device, ${self.source})`);
    for (const [coll, n] of Object.entries(res.retagged)) console.log(`  ${coll.padEnd(12)} ${verb} ${n}`);
    console.log(`  devices/${from}: ${res.device === 'deleted' ? (dryRun ? 'would be deleted' : 'deleted') : 'not there'}`);
    if (res.master) console.log(`  master device: ${dryRun ? 'would move' : 'moved'} to ${self.deviceId}`);
    console.log(dryRun ? 'dry run: nothing written' : `done: ${res.batches} batch(es)`);
  }
  return res.refused ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`retag-device: ${(e as Error).message}`);
    process.exit(2);
  });
