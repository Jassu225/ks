// lib/db/index.ts — factory: selects a provider by config (db_provider).
// Adding a provider = implement the two interfaces in providers/<name>.ts and
// register it here; nothing else in the codebase changes.
import { loadConfig, type Config } from '../config.js';
import { createFirestoreProvider } from './providers/firestore.js';
import { createMemoryProvider } from './providers/memory.js';
import { createPocketbaseProvider } from './providers/pocketbase.js';
import type { DbProvider } from './types.js';

export function createProvider(cfg: Config = loadConfig()): DbProvider {
  // Debug/dry-run: capture writes in memory, no transport.
  if (process.env.KS_FLOW_DRYRUN === '1') return createMemoryProvider();
  switch (cfg.dbProvider) {
    case 'pocketbase':
      return createPocketbaseProvider(cfg);
    case 'firestore':
      return createFirestoreProvider(cfg);
    case 'file':
    case 'sqlite':
      throw new Error(
        `db_provider="${cfg.dbProvider}" is a documented future slot, not implemented. Use "pocketbase" (default) or "firestore".`,
      );
    default:
      throw new Error(`Unknown db_provider: "${cfg.dbProvider}"`);
  }
}

export * from './types.js';
