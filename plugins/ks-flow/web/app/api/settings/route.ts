// /api/settings — read/write board-local settings (NOT project.conf, which the
// bootstrap rewrites). Holds the worktree-removal command and the GCS-archive
// config (enable + bucket + optional object prefix; sensitive creds live in
// $CLAUDE_PLUGIN_DATA/.env, never here).
//
// GET  → { removeCommand, gcsArchive, reminders, notes, briefing, … }
// POST { removeCommand?, gcsArchive?, reminders?, notes?, briefing? } → persist
// (merges with existing; blocks this route doesn't know are kept as they are).
//
// Several devices (src/lib/sharedsettings.ts): the shared blocks (briefing,
// notes, reminders, gcsArchive, transcriptBackup) live in the store's
// meta/settings; removeCommand stays local. board-settings.json is the local
// mirror every synchronous reader keeps using, so a save writes BOTH: the file
// (now) and meta/settings (queued in the outbox when offline), each stamped
// with the same `sharedUpdatedAt`. The daemon mirrors other devices' saves
// into the file and never lets an older store copy overwrite a newer local
// save. A read takes the store's blocks when its copy is at least as new as
// the file's. Before the device backfill (no meta/settings) and on PocketBase
// (one device; its daemon pushes the file into its store) only the file is
// written, as always.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { loadDataEnv } from '@/lib/envfile';
import { getSettingsDoc, mergeSettingsDoc, serverConfig, SHARED_SETTINGS_BLOCKS } from '@/lib/serverdb';
import type { SettingsDoc } from '@/lib/types';
import { readOnlyResponse } from '@/lib/readonly';

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
// Briefing (docs/briefing.md): the master session's scheduled Slack passes.
// Defaults and validation mirror src/lib/boardsettings.ts briefingSettings().
interface Briefing {
  enabled: boolean;
  schedule: string[];
  names: string[];
  halfTime: string[];
}
interface Settings {
  removeCommand: string;
  gcsArchive: GcsArchive;
  reminders: Reminders;
  notes: Notes;
  briefing: Briefing;
}

const DEFAULT_BRIEFING: Briefing = {
  enabled: false,
  schedule: ['00:00', '06:00', '12:00', '18:00'],
  names: ['Jaswanth'],
  halfTime: [],
};
const SLOT = /^([01]\d|2[0-3]):[0-5]\d$/;

function strings(v: unknown, dflt: string[], ok: (x: string) => boolean = () => true): string[] {
  return Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(ok))]
    : [...dflt];
}

/** A `briefing` block as briefingSettings() reads it; missing fields from `base`. */
function parseBriefing(b: Record<string, unknown>, base: Briefing): Briefing {
  return {
    enabled: typeof b.enabled === 'boolean' ? b.enabled : base.enabled,
    schedule: strings(b.schedule, base.schedule, (x) => SLOT.test(x)).sort(),
    names: strings(b.names, base.names, (x) => x !== ''),
    halfTime: strings(b.halfTime, base.halfTime, (x) => x !== ''),
  };
}

/** The whole file as stored, so a save keeps blocks this route does not edit
 * (e.g. transcriptBackup, read by the daemon's backupSettings()). */
function readRaw(): Record<string, unknown> {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

const DEFAULT_GCS: GcsArchive = { enabled: false, bucket: '', prefix: '' };
const DEFAULT_REMINDERS: Reminders = {
  enabled: true,
  stopIntervalMin: 5,
  capCount: 12,
  debounceSec: 60,
};
const DEFAULT_NOTES: Notes = { enabled: false, slack: false, linear: false };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const stampOf = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The file with the store's shared blocks laid over it when the store's copy is at least as new. */
function withStore(raw: Raw, doc: SettingsDoc | null | undefined): Raw {
  if (!doc || stampOf(doc.sharedUpdatedAt) < stampOf(raw.sharedUpdatedAt)) return raw;
  const out: Raw = { ...raw };
  for (const k of SHARED_SETTINGS_BLOCKS) {
    const v = (doc as unknown as Raw)[k];
    if (isObj(v)) out[k] = v;
    else delete out[k];
  }
  if (doc.sharedUpdatedAt) out.sharedUpdatedAt = doc.sharedUpdatedAt;
  if (doc.masterDeviceId) out.masterDeviceId = doc.masterDeviceId;
  return out;
}

/** The settings as stored: the file, with the store's newer shared blocks (Firestore). */
async function readEffective(): Promise<{ raw: Raw; doc: SettingsDoc | null | undefined }> {
  const raw = readRaw();
  if (serverConfig().dbProvider !== 'firestore') return { raw, doc: undefined };
  const doc = await getSettingsDoc();
  return { raw: withStore(raw, doc), doc };
}

function read(raw: Raw = readRaw()): Settings {
  try {
    const s = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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
      briefing: parseBriefing(
        s.briefing && typeof s.briefing === 'object' ? s.briefing : {},
        DEFAULT_BRIEFING,
      ),
    };
  } catch {
    return {
      removeCommand: '',
      gcsArchive: { ...DEFAULT_GCS },
      reminders: { ...DEFAULT_REMINDERS },
      notes: { ...DEFAULT_NOTES },
      briefing: { ...DEFAULT_BRIEFING },
    };
  }
}

export async function GET(): Promise<NextResponse> {
  loadDataEnv(join(dataDir(), '.env'));
  // When GCS_BUCKET is set in .env it WINS over the stored value (see
  // archive-core.ts resolveGcsConfig); the UI shows it read-only in that case.
  const gcsBucketEnv = (process.env.GCS_BUCKET ?? '').trim();
  // Notes source sections gate on their token's presence (Slack fetches a message
  // by permalink; Linear uses its key). Only booleans leave the server.
  const slackTokenPresent = !!(process.env.SLACK_TOKEN ?? '').trim();
  const linearKeyPresent = !!(process.env.LINEAR_API_KEY ?? '').trim();
  const { raw } = await readEffective();
  return NextResponse.json({ ...read(raw), gcsBucketEnv, slackTokenPresent, linearKeyPresent });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: {
    removeCommand?: string;
    gcsArchive?: Partial<GcsArchive>;
    reminders?: Partial<Reminders>;
    notes?: Partial<Notes>;
    briefing?: Partial<Briefing>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  // The shared blocks go to the store: refused while this device is behind the
  // store's data format (lib/readonly.ts). removeCommand is this device's own.
  if (SHARED_SETTINGS_BLOCKS.some((k) => (body as Record<string, unknown>)[k] !== undefined)) {
    const readOnly = readOnlyResponse();
    if (readOnly) return readOnly;
  }

  const { raw, doc } = await readEffective();
  const current = read(raw);
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

  if (body.briefing && typeof body.briefing === 'object') {
    next.briefing = parseBriefing(body.briefing as Record<string, unknown>, current.briefing);
  }

  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sharedUpdatedAt = new Date().toISOString();
  const content: Raw = { ...raw, ...next, sharedUpdatedAt };
  // Temp file + rename: the daemon's mirror and the shell readers never see half a file.
  const tmp = join(dir, `.board-settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(content, null, 2));
  renameSync(tmp, settingsPath());

  // Device mode on Firestore: meta/settings exists (or, offline, the daemon's
  // mirror left its masterDeviceId in the file). Before the backfill the store
  // is not touched: a partial meta/settings would switch every daemon over.
  let storeWarning: string | undefined;
  const deviceMode = doc != null || (doc === undefined && typeof raw.masterDeviceId === 'string' && raw.masterDeviceId !== '');
  if (serverConfig().dbProvider === 'firestore' && deviceMode) {
    const patch: Raw = { sharedUpdatedAt };
    for (const k of SHARED_SETTINGS_BLOCKS) if (isObj(content[k])) patch[k] = content[k];
    try {
      await mergeSettingsDoc(patch as Partial<SettingsDoc>);
    } catch (e) {
      // The file has the save; the daemon pushes it to the store on its next pass.
      storeWarning = `saved on this device; the shared copy is updated by the daemon shortly (${(e as Error)?.message ?? e})`;
      console.error('[ks-flow] settings: meta/settings write failed:', (e as Error)?.message ?? e);
    }
  }
  return NextResponse.json({ ok: true, ...next, ...(storeWarning ? { warning: storeWarning } : {}) });
}
