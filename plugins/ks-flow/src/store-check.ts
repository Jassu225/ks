#!/usr/bin/env node
// store-check.ts — one line per fact about the store, for `ks-flow status`:
// which provider the daemon resolves, whether it answers (one read, 8 s cap),
// and, with Firestore, how many writes wait in the offline outbox.
//   node dist/store-check.js [--json]
import { join } from 'node:path';
import { dataDir, loadConfig, readProjectConf } from './lib/config.js';
import { createProvider } from './lib/db/index.js';
import { outboxCount } from './lib/db/outbox.js';

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
  if (conf) {
    try {
      const read = createProvider(cfg).source().getProject(conf.projectId);
      await Promise.race([
        read,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
      ]);
      ok = true;
    } catch (e) {
      error = (e as Error).message;
    }
  } else {
    error = 'no project.conf';
  }
  const pending = cfg.dbProvider === 'firestore' ? outboxCount(join(dataDir(), 'outbox')) : 0;
  const failed = cfg.dbProvider === 'firestore' ? outboxCount(join(dataDir(), 'outbox', 'failed')) : 0;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ provider: cfg.dbProvider, where, ok, error: error || undefined, pending, failed }));
    return;
  }
  console.log(`  ${cfg.dbProvider} (${where}): ${ok ? 'reachable' : `NOT reachable — ${error}`}`);
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
