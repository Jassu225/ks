// Live Linear fields for the board's tickets.
//
// A card's title, status, priority, estimate and URL come from its state.yaml —
// a snapshot taken when the ticket was started, which goes stale as the ticket
// moves in Linear. The daemon's `linear` job reads the current values for every
// ticket on the board in ONE call (`linear issue batch-get`, one GraphQL query
// per team) and lays them over the state.yaml values.
//
// Goes through the ks plugin's `linear` CLI rather than the Linear API, as every
// Linear call in this repo does: it owns the API key (plugins/ks/scripts/.env).

import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { resolveBinary } from './archive-core.js';

/** What Linear says about one issue, as the card shows it. */
export interface LinearFacts {
  title: string;
  url: string;
  priority: { value: number; name: string };
  estimate: number | null;
  status: { name: string; type: string; color: string } | null;
  /** When the daemon read these from Linear. */
  syncedAt: string;
}

interface IssueFactsJson {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  state: { name: string; type: string; color: string } | null;
}

let linearBin: string | null | undefined;

/**
 * Current Linear fields for `identifiers`, keyed by identifier. Throws when the
 * CLI is missing or the call fails, so the caller keeps its last good values.
 */
export async function fetchLinearFacts(identifiers: string[]): Promise<Map<string, LinearFacts>> {
  const out = new Map<string, LinearFacts>();
  if (identifiers.length === 0) return out;
  // Resolved through the login shell once (launchd's PATH lacks it); retried
  // after a miss so installing ks later needs no daemon restart.
  if (!linearBin) linearBin = resolveBinary('linear');
  if (!linearBin) throw new Error('linear CLI not found (the ks plugin puts it on PATH)');

  // The wrapper runs `npx tsx`: give it the daemon's own node on PATH.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      linearBin!,
      ['issue', 'batch-get', ...identifiers, '--json'],
      { env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (err, so, se) => (err ? reject(new Error(`${err.message}${se ? ` — ${se.trim().slice(0, 300)}` : ''}`)) : resolve(so)),
    );
  });

  const parsed = JSON.parse(stdout) as { issues: IssueFactsJson[] };
  const syncedAt = new Date().toISOString();
  for (const i of parsed.issues ?? []) {
    out.set(i.identifier, {
      title: i.title,
      url: i.url,
      priority: { value: i.priority, name: i.priorityLabel },
      estimate: i.estimate ?? null,
      status: i.state ? { name: i.state.name, type: i.state.type, color: i.state.color } : null,
      syncedAt,
    });
  }
  return out;
}
