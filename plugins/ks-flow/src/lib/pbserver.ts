// lib/pbserver.ts — supervises a local PocketBase server as a child of the
// daemon. The daemon is the single always-on process, so tying PocketBase's
// lifecycle to it (rather than a second launchd agent) keeps ordering trivial:
// we spawn, wait for /api/health, and only then start ingesting. On unexpected
// exit we respawn with a short backoff; on shutdown we SIGTERM it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { POCKETBASE_BIN, POCKETBASE_DATA, POCKETBASE_MIGRATIONS } from './paths.js';

export interface PbHandle {
  stop(): void;
}

const HEALTH_TIMEOUT_MS = 30_000;
const RESPAWN_DELAY_MS = 2_000;

export async function startPocketbase(
  port: number,
  log: (...a: unknown[]) => void,
): Promise<PbHandle> {
  if (!existsSync(POCKETBASE_BIN)) {
    throw new Error(
      `pocketbase binary missing at ${POCKETBASE_BIN} — run bootstrap (\`ks-flow install-daemon\`)`,
    );
  }

  let child: ChildProcess | null = null;
  let stopped = false;

  const spawnPb = (): void => {
    child = spawn(
      POCKETBASE_BIN,
      [
        'serve',
        `--http=127.0.0.1:${port}`,
        `--dir=${POCKETBASE_DATA}`,
        `--migrationsDir=${POCKETBASE_MIGRATIONS}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Funnel PocketBase output through the daemon log so everything lands in
    // the same (truncated-on-start) daemon.log.
    const forward = (buf: Buffer): void => {
      const s = buf.toString().trimEnd();
      if (s) log('[pocketbase]', s);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('exit', (code) => {
      if (stopped) return;
      log(`pocketbase exited (code=${code}); respawning in ${RESPAWN_DELAY_MS}ms`);
      setTimeout(spawnPb, RESPAWN_DELAY_MS);
    });
  };
  spawnPb();

  // Wait for the HTTP API to answer before returning — the daemon must not
  // start writing until the server (and its migrations) are ready.
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const r = await fetch(healthUrl);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`pocketbase did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  log(`pocketbase healthy on 127.0.0.1:${port}`);

  return {
    stop(): void {
      stopped = true;
      child?.kill('SIGTERM');
    },
  };
}
