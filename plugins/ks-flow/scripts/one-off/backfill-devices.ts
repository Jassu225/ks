// backfill-devices.ts — ONE-TIME move of the Firestore store to the
// several-devices model (one ks-flow board for several devices). Not part of
// the ks-flow CLI: run it by hand, once, on the device that has been using the
// board, BEFORE starting ks-flow on any other device.
//
//   cd plugins/ks-flow/src && npm ci          # its dependencies (once)
//   npx tsx ../scripts/one-off/backfill-devices.ts --dry-run   # counts only
//   npx tsx ../scripts/one-off/backfill-devices.ts             # do it
//   (or `node --import tsx ../scripts/one-off/backfill-devices.ts`, where
//   the tsx CLI can't open its IPC pipe, e.g. inside a sandbox)
//
// Options:
//   --dry-run          print what it would do (counts), write nothing
//   --data-dir <dir>   the ks-flow data dir (default: as `ks-flow` resolves it,
//                      src/lib/pick-datadir.ts: KS_FLOW_DATA, else the configured
//                      project's — the current directory's, else the only one)
//   --json             print the result as JSON
//
// What it does (the logic is src/lib/device-backfill.ts, tested):
//   1. creates meta/settings — this device's board-settings.json shared blocks
//      (briefing, notes, reminders, gcsArchive, transcriptBackup) and
//      masterDeviceId = this device; refuses when meta/settings exists;
//   2. tags every workUnits / sessions / backupRuns / backupUnits /
//      masterEvents doc without a deviceId with this device (merge ops,
//      ≤ 500 per batch, through the offline outbox);
//   3. copies meta/project into devices/<this device>, then deletes it.
// The running daemon notices meta/settings within a minute and switches to
// devices/<id> on its own; until then it logs that this script is due.
//
// Exit: 0 done (or dry run), 1 refused, 2 error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<number> {
  // The data dir as `ks-flow` picks it, so the script works from any
  // directory; pinned in KS_FLOW_DATA before config.ts resolves it.
  const { pickDataDir } = await import('../../src/lib/pick-datadir.js');
  const picked = pickDataDir({ flag: arg('--data-dir') });
  if (picked.ambiguous) {
    console.error(`several ks-flow projects are configured: using ${picked.dir} (the current directory's). Pass --data-dir <dir> to choose.`);
  }
  process.env.KS_FLOW_DATA = picked.dir;
  const { dataDir, loadConfig } = await import('../../src/lib/config.js');
  const { createProvider } = await import('../../src/lib/db/index.js');
  const { deviceIdentity } = await import('../../src/lib/device.js');
  const { backfillDevices, sharedBlocks } = await import('../../src/lib/device-backfill.js');

  const cfg = loadConfig();
  if (cfg.dbProvider !== 'firestore') {
    console.error(`the store is ${cfg.dbProvider}: nothing to backfill (a PocketBase daemon sets itself up)`);
    return 1;
  }
  const data = dataDir();
  let boardSettings: unknown = {};
  try {
    boardSettings = JSON.parse(readFileSync(join(data, 'board-settings.json'), 'utf8'));
  } catch {
    /* no settings file: the shared blocks start empty (defaults) */
  }
  const id = deviceIdentity(data);
  const provider = createProvider(cfg);
  const db = provider.docDb?.();
  if (!db) throw new Error('this store has no path-level access');
  const dryRun = has('--dry-run');
  const res = await backfillDevices(db, {
    deviceId: id.deviceId,
    defaultName: id.defaultName,
    platform: process.platform,
    shared: sharedBlocks(boardSettings),
    dryRun,
    log: (m) => console.error(`  ${m}`),
  });
  const pending = provider.outbox?.().pending() ?? 0;
  if (has('--json')) {
    console.log(JSON.stringify({ deviceId: id.deviceId, device: id.defaultName, dataDir: data, ...res, outboxPending: pending }, null, 2));
  } else {
    console.log(`device ${id.deviceId} (${id.defaultName}), data dir ${data}`);
    if (res.refused) console.log(`refused: ${res.refused}`);
    else {
      const verb = dryRun ? 'would tag' : 'tagged';
      for (const [coll, n] of Object.entries(res.tagged)) {
        console.log(`  ${coll.padEnd(12)} ${verb} ${n}, already tagged ${res.alreadyTagged[coll as keyof typeof res.tagged]}`);
      }
      console.log(`  meta/project: ${res.project === 'copied' ? (dryRun ? 'would be copied into devices/' + id.deviceId + ' and deleted' : 'copied and deleted') : 'none'}`);
      if (dryRun) console.log('dry run: nothing written');
      else {
        console.log(`done${res.resumed ? ' (resumed)' : ''}: ${res.batches} tag batch(es); meta/settings masterDeviceId = ${id.deviceId}`);
        if (pending) console.log(`${pending} write(s) wait in the offline outbox; the daemon syncs them`);
      }
    }
  }
  return res.refused ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`backfill-devices: ${(e as Error).message}`);
    process.exit(2);
  });
