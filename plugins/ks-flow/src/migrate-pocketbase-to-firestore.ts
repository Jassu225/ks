#!/usr/bin/env node
// migrate-pocketbase-to-firestore.ts — one-off copy of the local PocketBase
// store into Firestore (cloud), before switching ks-flow's store over.
//
//   node dist/migrate-pocketbase-to-firestore.js [options]
//   (or: npx tsx migrate-pocketbase-to-firestore.ts [options])
//     --project <gcp id>      Firestore project (default: gcp_project_id / FIREBASE_PROJECT_ID)
//     --credentials <file>    service-account key JSON (default: firestore_credentials /
//                             FIRESTORE_CREDENTIALS, then Application Default Credentials)
//     --write                 actually write; without it this is a dry run (PocketBase only)
//     --force                 write even though the Firestore project already holds data
//
// PocketBase must be running (it runs with the daemon while db_provider is
// pocketbase). Copies what the daemon can't rebuild:
//   reminders (incl. Notes and pause flags), briefing items / runs / daily logs,
//   master events, backup runs, backup units (so the next sweep doesn't
//   re-upload everything), and the global slack_names cache.
// Skips projects / work units / sessions: the daemon's startup backfill
// rewrites them from the session JSONL and state.yaml.
//
// Writes go straight to Firestore (not the offline outbox), whole docs, by the
// same paths the Firestore provider uses; a re-run overwrites with the same data.
import PocketBase from 'pocketbase';
import { join } from 'node:path';
import { dataDir, loadConfig, readProjectConf, type Config } from './lib/config.js';
import { loadDataEnv } from './lib/envfile.js';
import { createPocketbaseProvider } from './lib/db/providers/pocketbase.js';
import { createFirestoreProvider, directFirestoreStore } from './lib/db/providers/firestore.js';
import type { StoreOp } from './lib/db/outbox.js';

const BATCH = 400;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

interface Coll {
  /** Top-level Firestore collection (the store is flat). */
  name: string;
  docs: Array<Record<string, unknown>>;
  id: (d: Record<string, unknown>) => string;
}

async function main(): Promise<void> {
  loadDataEnv(join(dataDir(), '.env'));
  const conf = readProjectConf();
  if (!conf) throw new Error(`no project.conf in ${dataDir()} — run ks-flow start once first`);
  const projectId = conf.projectId;
  const base = loadConfig();
  const write = has('--write');

  // ── read PocketBase ──────────────────────────────────────────────────────
  const pbCfg: Config = { ...base, dbProvider: 'pocketbase' };
  const pbProv = createPocketbaseProvider(pbCfg);
  const pb = new PocketBase(pbCfg.pocketbaseUrl);
  pb.autoCancellation(false);
  try {
    await pb.health.check();
  } catch {
    throw new Error(`PocketBase is not reachable at ${pbCfg.pocketbaseUrl} — start it (ks-flow start, with db_provider still pocketbase)`);
  }
  const asRec = <T>(xs: T[]) => xs as unknown as Array<Record<string, unknown>>;
  const uid = (d: Record<string, unknown>) => String(d.uid);
  const slack = (await pb.collection('slack_names').getFullList()).map((r) => ({
    uid: String(r.uid),
    name: String(r.name),
  }));
  const colls: Coll[] = [
    { name: 'reminders', docs: asRec(await pbProv.writer().getReminders(projectId)), id: uid },
    { name: 'briefingItems', docs: asRec(await pbProv.briefing().getBriefingItems(projectId)), id: uid },
    { name: 'briefingRuns', docs: asRec(await pbProv.briefing().getBriefingRuns(projectId)), id: uid },
    { name: 'dailyLogs', docs: asRec(await pbProv.briefing().getDailyLogs(projectId)), id: uid },
    { name: 'masterEvents', docs: asRec(await pbProv.briefing().getMasterEvents(projectId, 100_000)), id: uid },
    { name: 'backupRuns', docs: asRec(await pbProv.backups().getBackupRuns(projectId)), id: uid },
    { name: 'backupUnits', docs: asRec(await pbProv.backups().getBackupUnits(projectId)), id: uid },
    { name: 'slack_names', docs: asRec(slack.filter((s) => s.uid && s.name)), id: uid },
  ];

  console.log(`project ${projectId}: PocketBase ${pbCfg.pocketbaseUrl}`);
  for (const c of colls) {
    const biggest = c.docs.reduce((m, d) => Math.max(m, JSON.stringify(d).length), 0);
    console.log(`  ${c.name.padEnd(14)} ${String(c.docs.length).padStart(5)} docs, largest ${biggest} bytes`);
    const missing = c.docs.filter((d) => !c.id(d) || c.id(d) === 'undefined').length;
    if (missing) throw new Error(`${c.name}: ${missing} doc(s) without a uid`);
  }
  if (!write) {
    console.log('dry run: nothing written (add --write)');
    return;
  }

  // ── write Firestore ──────────────────────────────────────────────────────
  const fsCfg: Config = {
    ...base,
    dbProvider: 'firestore',
    firestoreMode: 'cloud',
    gcpProjectId: arg('--project') ?? base.gcpProjectId,
    firestoreCredentials: arg('--credentials') ?? base.firestoreCredentials,
  };
  if (!fsCfg.gcpProjectId) throw new Error('no Firestore project: pass --project <gcp id>');
  if (arg('--credentials')) {
    // an explicit key file wins over any client-email/private-key pair in the env
    fsCfg.firestoreClientEmail = undefined;
    fsCfg.firestorePrivateKey = undefined;
  }
  const fsProv = createFirestoreProvider(fsCfg);
  const existing = [
    (await fsProv.writer().getReminders(projectId)).length,
    (await fsProv.briefing().getBriefingItems(projectId)).length,
    (await fsProv.backups().getBackupUnits(projectId)).length,
  ].reduce((a, b) => a + b, 0);
  if (existing > 0 && !has('--force')) {
    throw new Error(
      `Firestore project ${fsCfg.gcpProjectId} already holds ks-flow data for ${projectId} (${existing} docs) — re-run with --force to overwrite`,
    );
  }

  const store = directFirestoreStore(fsCfg);
  const ops: StoreOp[] = [];
  for (const c of colls) {
    const prefix = c.name; // flat: every collection sits at the database root
    for (const d of c.docs) {
      ops.push({ op: 'set', path: `${prefix}/${c.id(d)}`, data: JSON.parse(JSON.stringify(d)) });
    }
  }
  for (let i = 0; i < ops.length; i += BATCH) {
    await store.apply(ops.slice(i, i + BATCH));
    console.log(`  wrote ${Math.min(i + BATCH, ops.length)}/${ops.length}`);
  }

  // read back what the board relies on most
  const back = {
    reminders: (await fsProv.writer().getReminders(projectId)).length,
    briefingItems: (await fsProv.briefing().getBriefingItems(projectId)).length,
    backupUnits: (await fsProv.backups().getBackupUnits(projectId)).length,
  };
  console.log(`done → Firestore ${fsCfg.gcpProjectId}; read back: ${JSON.stringify(back)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[ks-flow migrate] ${(e as Error).message}`);
    process.exit(1);
  });
