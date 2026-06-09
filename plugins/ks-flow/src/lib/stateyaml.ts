// lib/stateyaml.ts — parse a ks workflow state.yaml into a (partial) WorkUnitDoc.
//
// Tolerant by design: ks may be mid-write, so a parse failure must not crash
// the daemon — the caller keeps the last good doc and retries on the next
// change event.
import { readFileSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { parse } from 'yaml';
import type { PhaseEntry, PhaseStatus, PrRef, WorkUnitDoc } from './db/types.js';
import { expandTilde } from './paths.js';

const PHASE_STATUSES: ReadonlySet<string> = new Set([
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'SKIPPED',
  'REVISITING',
  'INVALIDATED',
]);

function asStatus(v: unknown): PhaseStatus {
  return typeof v === 'string' && PHASE_STATUSES.has(v) ? (v as PhaseStatus) : 'NOT_STARTED';
}

function mapPhases(raw: unknown): PhaseEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PhaseEntry[] = [];
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    if (typeof o.number !== 'number' || typeof o.name !== 'string') continue;
    const iterations = Array.isArray(o.iterations)
      ? o.iterations.map((it) => {
          const i = (it ?? {}) as Record<string, unknown>;
          return {
            startedAt: (i.started_at as string) ?? null,
            endedAt: (i.ended_at as string) ?? null,
          };
        })
      : undefined;
    out.push({
      number: o.number,
      name: o.name,
      status: asStatus(o.status),
      startedAt: (o.started_at as string) ?? null,
      endedAt: (o.ended_at as string) ?? null,
      ...(iterations ? { iterations } : {}),
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

function prFromSlack(slack: unknown): PrRef | null {
  if (typeof slack !== 'object' || slack === null) return null;
  const threads = (slack as Record<string, unknown>).pr_review_threads;
  if (!Array.isArray(threads)) return null;
  for (const t of threads) {
    const url = (t as Record<string, unknown>)?.pr_url;
    if (typeof url === 'string' && url) {
      const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      return {
        url,
        number: m ? Number(m[2]) : null,
        repo: m ? m[1] : null,
      };
    }
  }
  return null;
}

/** Infer ticket vs project from the entity key, falling back to the path. */
function inferType(doc: Record<string, unknown>, path: string): 'ticket' | 'project' {
  if (doc.ticket) return 'ticket';
  if (doc.project) return 'project';
  return path.includes(`${sep}tickets${sep}`) ? 'ticket' : 'project';
}

export interface ParsedWorkUnit {
  doc: Omit<WorkUnitDoc, 'currentPhase' | 'waiting' | 'sessionIds' | 'lastActivity' | 'updatedAt'>;
}

/** Parse a state.yaml file. Returns null on read/parse failure. */
export function parseStateYaml(path: string): ParsedWorkUnit | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
    if (typeof doc !== 'object' || doc === null) return null;
  } catch {
    return null; // mid-write / malformed — keep last good
  }

  const type = inferType(doc, path);
  const entity = (doc[type] ?? {}) as Record<string, unknown>;
  const identifier =
    (typeof entity.identifier === 'string' && entity.identifier) ||
    basename(dirname(path));
  const status = (entity.status ?? null) as Record<string, unknown> | null;
  const priority = (entity.priority ?? null) as Record<string, unknown> | null;
  const worktreeDir =
    typeof doc.worktree_dir === 'string' ? expandTilde(doc.worktree_dir) : null;

  return {
    doc: {
      unitId: identifier,
      type,
      identifier,
      title: typeof entity.name === 'string' ? entity.name : identifier,
      linearStatus: status && typeof status.name === 'string' ? status.name : null,
      priority: priority
        ? {
            value: typeof priority.value === 'number' ? priority.value : null,
            name: typeof priority.name === 'string' ? priority.name : '',
          }
        : null,
      estimate: typeof entity.estimate === 'number' ? entity.estimate : null,
      worktreeDir,
      stateYamlPath: path,
      phases: mapPhases(doc.phases),
      pr: prFromSlack(doc.slack),
      slack: doc.slack ?? null,
    },
  };
}
