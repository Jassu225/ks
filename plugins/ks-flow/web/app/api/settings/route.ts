// /api/settings — read/write board-local settings (NOT project.conf, which the
// bootstrap rewrites). Holds the worktree-removal command and the GCS-archive
// config (enable + bucket + optional object prefix; sensitive creds live in
// $CLAUDE_PLUGIN_DATA/.env, never here).
//
// GET  → { removeCommand, gcsArchive: { enabled, bucket, prefix } }
// POST { removeCommand?, gcsArchive? } → persist (merges with existing).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}
const settingsPath = (): string => join(dataDir(), 'board-settings.json');

// Pull $dataDir/.env into process.env (real env wins) so we can tell whether
// GCS_BUCKET is configured via env — the bucket is env-aware in the UI.
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

interface GcsArchive {
  enabled: boolean;
  bucket: string;
  prefix: string;
}
interface Reminders {
  enabled: boolean;
  stopIntervalMin: number;
  capCount: number;
  debounceSec: number;
}
// Notes page: master `enabled` (generic section shows whenever on), plus
// per-source toggles. A source section only renders when its toggle is on AND
// the matching token is present in $CLAUDE_PLUGIN_DATA/.env (reported by GET).
interface Notes {
  enabled: boolean;
  slack: boolean;
  linear: boolean;
}
interface Settings {
  removeCommand: string;
  gcsArchive: GcsArchive;
  reminders: Reminders;
  notes: Notes;
}

const DEFAULT_GCS: GcsArchive = { enabled: false, bucket: '', prefix: '' };
const DEFAULT_REMINDERS: Reminders = {
  enabled: true,
  stopIntervalMin: 5,
  capCount: 12,
  debounceSec: 60,
};
const DEFAULT_NOTES: Notes = { enabled: false, slack: false, linear: false };

function read(): Settings {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const g = s.gcsArchive ?? {};
    const r = s.reminders ?? {};
    const n = s.notes ?? {};
    return {
      removeCommand: typeof s.removeCommand === 'string' ? s.removeCommand : '',
      gcsArchive: {
        enabled: g.enabled === true,
        bucket: typeof g.bucket === 'string' ? g.bucket : '',
        prefix: typeof g.prefix === 'string' ? g.prefix : '',
      },
      reminders: {
        enabled: r.enabled !== false,
        stopIntervalMin:
          typeof r.stopIntervalMin === 'number' && r.stopIntervalMin > 0
            ? r.stopIntervalMin
            : DEFAULT_REMINDERS.stopIntervalMin,
        capCount:
          typeof r.capCount === 'number' && r.capCount > 0 ? r.capCount : DEFAULT_REMINDERS.capCount,
        debounceSec:
          typeof r.debounceSec === 'number' && r.debounceSec >= 0
            ? r.debounceSec
            : DEFAULT_REMINDERS.debounceSec,
      },
      notes: {
        enabled: n.enabled === true,
        slack: n.slack === true,
        linear: n.linear === true,
      },
    };
  } catch {
    return {
      removeCommand: '',
      gcsArchive: { ...DEFAULT_GCS },
      reminders: { ...DEFAULT_REMINDERS },
      notes: { ...DEFAULT_NOTES },
    };
  }
}

export async function GET(): Promise<NextResponse> {
  loadEnvFile(join(dataDir(), '.env'));
  // When GCS_BUCKET is set in .env it WINS over the stored value (see
  // archive-core.ts resolveGcsConfig); the UI shows it read-only in that case.
  const gcsBucketEnv = (process.env.GCS_BUCKET ?? '').trim();
  // Notes source sections gate on their token's presence (Slack fetches a message
  // by permalink; Linear uses its key). Only booleans leave the server.
  const slackTokenPresent = !!(process.env.SLACK_TOKEN ?? '').trim();
  const linearKeyPresent = !!(process.env.LINEAR_API_KEY ?? '').trim();
  return NextResponse.json({ ...read(), gcsBucketEnv, slackTokenPresent, linearKeyPresent });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: {
    removeCommand?: string;
    gcsArchive?: Partial<GcsArchive>;
    reminders?: Partial<Reminders>;
    notes?: Partial<Notes>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const current = read();
  const next: Settings = { ...current };
  if (typeof body.removeCommand === 'string') {
    next.removeCommand = body.removeCommand.trim();
  }
  if (body.gcsArchive && typeof body.gcsArchive === 'object') {
    const g = body.gcsArchive;
    next.gcsArchive = {
      enabled: typeof g.enabled === 'boolean' ? g.enabled : current.gcsArchive.enabled,
      bucket: typeof g.bucket === 'string' ? g.bucket.trim() : current.gcsArchive.bucket,
      prefix: typeof g.prefix === 'string' ? g.prefix.trim() : current.gcsArchive.prefix,
    };
  }
  if (body.reminders && typeof body.reminders === 'object') {
    const r = body.reminders;
    next.reminders = {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : current.reminders.enabled,
      stopIntervalMin:
        typeof r.stopIntervalMin === 'number' && r.stopIntervalMin > 0
          ? r.stopIntervalMin
          : current.reminders.stopIntervalMin,
      capCount:
        typeof r.capCount === 'number' && r.capCount > 0 ? r.capCount : current.reminders.capCount,
      debounceSec:
        typeof r.debounceSec === 'number' && r.debounceSec >= 0
          ? r.debounceSec
          : current.reminders.debounceSec,
    };
  }
  if (body.notes && typeof body.notes === 'object') {
    const n = body.notes;
    next.notes = {
      enabled: typeof n.enabled === 'boolean' ? n.enabled : current.notes.enabled,
      slack: typeof n.slack === 'boolean' ? n.slack : current.notes.slack,
      linear: typeof n.linear === 'boolean' ? n.linear : current.notes.linear,
    };
  }

  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return NextResponse.json({ ok: true, ...next });
}
