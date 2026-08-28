#!/usr/bin/env npx tsx
/**
 * Grain CLI - A command-line interface for the Grain public API (v2)
 *
 * Docs: https://developers.grain.com/  (single-page reference, API version 2025-10-31)
 *
 * Usage: npx tsx grain-cli.ts <command> [options]
 *
 * Environment: GRAIN_API_TOKEN must be set (loaded from .env file).
 *   Generate a Personal or Workspace access token at
 *   https://grain.com/app/settings/integrations?tab=api
 *   Optional: GRAIN_STORAGE_DIR (default ~/Documents/Grain), GRAIN_API_VERSION
 *   (default 2025-10-31), GRAIN_API_BASE_URL (default https://api.grain.com),
 *   GRAIN_OAUTH_CLIENT_ID / GRAIN_OAUTH_CLIENT_SECRET for the OAuth2 commands.
 *
 * Secrets are read from the environment only — no command takes a token as an
 * argument, so nothing lands in shell history or `ps` output.
 */

import { Command, Option } from 'commander';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

import { loadEnv } from './lib/env.js';

loadEnv();

// ============================================================================
// Constants
// ============================================================================

const BASE_URL = process.env.GRAIN_API_BASE_URL || 'https://api.grain.com';
const API_PREFIX = '/_/public-api';
const API_VERSION = process.env.GRAIN_API_VERSION || '2025-10-31';

/** Every hook_type the API accepts. */
const HOOK_TYPES = [
  'recording_added',
  'recording_updated',
  'recording_deleted',
  'highlight_added',
  'highlight_updated',
  'highlight_deleted',
  'story_added',
  'story_updated',
  'story_deleted',
  'upload_status',
] as const;

/** Boolean keys of the Recording Include object. */
const INCLUDE_KEYS = [
  'highlights',
  'participants',
  'ai_summary',
  'ai_action_items',
  'private_notes',
  'calendar_event',
  'hubspot',
  'screenshares',
] as const;

/** Transcript formats the API exposes. */
const TRANSCRIPT_FORMATS = ['json', 'txt', 'vtt', 'srt'] as const;

/** Extensions a Grain media download can arrive as. */
const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mp3', 'm4a'] as const;

/** Where `recording export` files land unless overridden. */
const DEFAULT_STORAGE_DIR = join(homedir(), 'Documents', 'Grain');

/** Tag validation, as documented: letters/digits, dash-separated, no leading dash. */
const TAG_REGEX = /^[\p{L}\d][\p{L}\d-]*$/u;

// ============================================================================
// Types (only the fields this CLI reads)
// ============================================================================

interface GrainTeam {
  id: string;
  name: string;
}

interface GrainMeetingType {
  id: string;
  name: string;
  scope?: string;
}

interface GrainUser {
  id: string;
  name: string;
  email: string;
}

interface GrainParticipant {
  id: string;
  name: string;
  email: string | null;
  scope?: string;
  confirmed_attendee?: boolean;
}

interface GrainHighlight {
  id: string;
  recording_id?: string;
  text?: string;
  timestamp?: number;
  duration?: number;
  tags?: string[];
  url?: string;
  transcript?: string;
  speakers?: string[];
  created_datetime?: string;
}

interface GrainRecording {
  id: string;
  title: string;
  start_datetime?: string;
  end_datetime?: string;
  duration_ms?: number;
  media_type?: string;
  source?: string;
  share_state?: string;
  url?: string;
  thumbnail_url?: string | null;
  tags?: string[];
  teams?: GrainTeam[];
  recorders?: { id: string; name: string; email: string; participant_id?: string | null }[];
  meeting_type?: GrainMeetingType | null;
  participants?: GrainParticipant[];
  highlights?: GrainHighlight[];
  ai_summary?: { text: string } | null;
  ai_action_items?: { text: string; status?: string; timestamp?: number; assignee?: { name?: string } | null }[];
  ai_template_sections?: { title: string; data: unknown }[];
  private_notes?: { text: string } | null;
  calendar_event?: Record<string, unknown> | null;
  hubspot?: Record<string, unknown> | null;
  screenshares?: { start: number; end: number; participant_id: string }[];
}

interface GrainHook {
  id: string;
  enabled: boolean;
  hook_url: string;
  hook_type: string;
  include?: Record<string, unknown>;
  inserted_at?: string;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  participant_id?: string | null;
}

// ============================================================================
// HTTP layer
// ============================================================================

function getToken(): string {
  const token = process.env.GRAIN_API_TOKEN || process.env.GRAIN_TOKEN;
  if (!token) {
    console.error(chalk.red('Error: GRAIN_API_TOKEN environment variable is not set'));
    console.error(
      chalk.yellow('Generate a Personal or Workspace access token at https://grain.com/app/settings/integrations?tab=api')
    );
    console.error(chalk.yellow('Then add it to plugins/ks/scripts/.env as GRAIN_API_TOKEN=...'));
    process.exit(1);
  }
  return token;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    'Public-Api-Version': API_VERSION,
    ...extra,
  };
}

/** Grain publishes 300 req/min and returns Retry-After when exceeded. */
async function grainFetch(
  method: string,
  path: string,
  init: { body?: unknown; accept?: string; maxRetries?: number; tolerate?: number[] } = {}
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${API_PREFIX}${path}`;
  const maxRetries = init.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const headers = authHeaders(init.accept ? { Accept: init.accept } : {});
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      console.error(chalk.red(`Network error calling ${method} ${url}`));
      console.error(chalk.gray(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      const wait = Number.isFinite(retryAfter) ? retryAfter : 5;
      console.error(chalk.yellow(`Rate limited (429). Waiting ${wait}s before retry ${attempt + 1}/${maxRetries}...`));
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      continue;
    }

    if (!res.ok && init.tolerate?.includes(res.status)) {
      return res;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(chalk.red(`Grain API error ${res.status} ${res.statusText} on ${method} ${url}`));
      if (text) console.error(chalk.gray(text.slice(0, 2000)));
      if (res.status === 401) {
        console.error(chalk.yellow('Check GRAIN_API_TOKEN — it may be revoked, or wrong token kind for this call.'));
      }
      if (res.status === 429) {
        console.error(chalk.yellow('Rate limit is 300 requests/minute per workspace.'));
      }
      process.exit(1);
    }

    return res;
  }
}

async function apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await grainFetch(method, path, { body, accept: 'application/json' });
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(chalk.red(`Expected JSON from ${method} ${path} but got:`));
    console.error(chalk.gray(text.slice(0, 500)));
    process.exit(1);
  }
}

// ============================================================================
// Output helpers
// ============================================================================

function output(data: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function formatDateTime(value: string | undefined | null): string {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return 'N/A';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTimecode(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '--:--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ============================================================================
// Local storage layout
// ============================================================================

/** `--dir` beats GRAIN_STORAGE_DIR beats ~/Documents/Grain. */
function storageRoot(override?: string): string {
  const dir = override || process.env.GRAIN_STORAGE_DIR || DEFAULT_STORAGE_DIR;
  return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
}

function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'untitled'
  );
}

/**
 * One folder per recording: `2026-08-20_all-hands_pppp6666`. Date first so the
 * directory sorts chronologically, id suffix so same-titled calls never collide.
 */
function recordingFolderName(r: GrainRecording): string {
  const date = (r.start_datetime || '').slice(0, 10) || 'no-date';
  return `${date}_${slugify(r.title || '')}_${r.id.split('-')[0]}`;
}

function printRecordingLine(r: GrainRecording): void {
  const when = r.start_datetime ? formatDateTime(r.start_datetime) : 'N/A';
  console.log(chalk.cyan(`\n${r.title || '(untitled)'}`));
  console.log(chalk.gray(`  id:       ${r.id}`));
  console.log(`  when:     ${when}  (${formatDuration(r.duration_ms)})`);
  const meta = [r.source, r.media_type, r.share_state].filter(Boolean).join(' · ');
  if (meta) console.log(`  meta:     ${meta}`);
  if (r.meeting_type) console.log(`  type:     ${r.meeting_type.name}${r.meeting_type.scope ? ` (${r.meeting_type.scope})` : ''}`);
  if (r.teams?.length) console.log(`  teams:    ${r.teams.map(t => t.name).join(', ')}`);
  if (r.tags?.length) console.log(`  tags:     ${r.tags.join(', ')}`);
  if (r.participants?.length) {
    const names = r.participants.map(p => `${p.name}${p.confirmed_attendee === false ? ' (no-show)' : ''}`);
    console.log(`  people:   ${names.join(', ')}`);
  }
  if (r.highlights?.length) console.log(`  clips:    ${r.highlights.length}`);
  if (r.url) console.log(chalk.gray(`  url:      ${r.url}`));
}

function printRecordingDetail(r: GrainRecording): void {
  printRecordingLine(r);

  if (r.ai_summary?.text) {
    console.log(chalk.bold('\n  AI summary:'));
    console.log(
      r.ai_summary.text
        .split('\n')
        .map(l => `    ${l}`)
        .join('\n')
    );
  }

  if (r.ai_action_items?.length) {
    console.log(chalk.bold('\n  Action items:'));
    r.ai_action_items.forEach(item => {
      const who = item.assignee?.name ? ` — ${item.assignee.name}` : '';
      const status = item.status === 'completed' ? chalk.green('[done]') : chalk.yellow('[pending]');
      console.log(`    ${status} ${formatTimecode(item.timestamp)} ${item.text}${who}`);
    });
  }

  if (r.ai_template_sections?.length) {
    console.log(chalk.bold('\n  AI template sections:'));
    r.ai_template_sections.forEach(section => {
      console.log(chalk.cyan(`    ${section.title}`));
      const body = typeof section.data === 'string' ? section.data : JSON.stringify(section.data, null, 2);
      console.log(
        body
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
      );
    });
  }

  if (r.private_notes?.text) {
    console.log(chalk.bold('\n  Private notes:'));
    console.log(
      r.private_notes.text
        .split('\n')
        .map(l => `    ${l}`)
        .join('\n')
    );
  }

  if (r.highlights?.length) {
    console.log(chalk.bold('\n  Highlights:'));
    r.highlights.forEach(h => {
      console.log(`    ${formatTimecode(h.timestamp)} ${h.text || '(no title)'} ${chalk.gray(h.id)}`);
      if (h.speakers?.length) console.log(chalk.gray(`      speakers: ${h.speakers.join(', ')}`));
      if (h.transcript) console.log(chalk.gray(`      ${h.transcript.slice(0, 300)}`));
    });
  }

  if (r.screenshares?.length) {
    console.log(chalk.bold('\n  Screenshares:'));
    r.screenshares.forEach(s => console.log(`    ${formatTimecode(s.start)} → ${formatTimecode(s.end)}  ${s.participant_id}`));
  }

  if (r.calendar_event) {
    console.log(chalk.bold('\n  Calendar event:'));
    console.log(`    ${JSON.stringify(r.calendar_event)}`);
  }

  if (r.hubspot) {
    console.log(chalk.bold('\n  HubSpot:'));
    console.log(`    ${JSON.stringify(r.hubspot)}`);
  }
}

function printHook(h: GrainHook): void {
  const state = h.enabled ? chalk.green('enabled') : chalk.yellow('disabled');
  console.log(`\n${chalk.cyan(h.hook_type)} ${state}`);
  console.log(chalk.gray(`  id:      ${h.id}`));
  console.log(`  url:     ${h.hook_url}`);
  if (h.include && Object.keys(h.include).length) console.log(`  include: ${JSON.stringify(h.include)}`);
  if (h.inserted_at) console.log(chalk.gray(`  created: ${formatDateTime(h.inserted_at)}`));
}

// ============================================================================
// Request-object builders
// ============================================================================

interface IncludeOptions {
  include?: string[];
  aiSections?: string;
  aiFormat?: string;
}

/**
 * Build the Recording Include object. `--include all` turns on every boolean key.
 * private_notes is Personal-API only, so it is excluded from `all` to keep
 * workspace-token calls from failing; ask for it explicitly when you need it.
 */
function buildInclude(options: IncludeOptions): Record<string, unknown> | undefined {
  const requested = new Set<string>();

  for (const raw of options.include || []) {
    for (const key of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      if (key === 'all') {
        INCLUDE_KEYS.filter(k => k !== 'private_notes').forEach(k => requested.add(k));
        continue;
      }
      const normalized = key.replace(/-/g, '_');
      if (!(INCLUDE_KEYS as readonly string[]).includes(normalized)) {
        console.error(chalk.red(`Unknown include key: ${key}`));
        console.error(chalk.yellow(`Valid keys: ${INCLUDE_KEYS.join(', ')}, all`));
        process.exit(1);
      }
      requested.add(normalized);
    }
  }

  const include: Record<string, unknown> = {};
  requested.forEach(key => {
    include[key] = true;
  });

  if (options.aiSections || options.aiFormat) {
    const sections: Record<string, unknown> = {};
    if (options.aiFormat) sections.format = options.aiFormat;
    if (options.aiSections) {
      sections.allowed_sections = options.aiSections
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
    include.ai_template_sections = sections;
  }

  return Object.keys(include).length ? include : undefined;
}

interface FilterOptions {
  after?: string;
  before?: string;
  attendance?: string;
  scope?: string;
  search?: string;
  team?: string;
  meetingType?: string;
}

function buildFilter(options: FilterOptions): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (options.after) filter.after_datetime = normalizeDatetime(options.after);
  if (options.before) filter.before_datetime = normalizeDatetime(options.before);
  if (options.attendance) filter.attendance = options.attendance;
  if (options.scope) filter.participant_scope = options.scope;
  if (options.search) filter.title_search = options.search;
  if (options.team) filter.team = options.team;
  if (options.meetingType) filter.meeting_type = options.meetingType;
  return Object.keys(filter).length ? filter : undefined;
}

/** Accept `2025-01-01` as well as a full ISO8601 timestamp. */
function normalizeDatetime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    console.error(chalk.red(`Invalid date: ${value}`));
    console.error(chalk.yellow('Use YYYY-MM-DD or an ISO8601 timestamp (2025-01-01T09:30:00Z)'));
    process.exit(1);
  }
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

// ============================================================================
// Recording commands
// ============================================================================

interface ListOptions extends IncludeOptions, FilterOptions {
  cursor?: string;
  all?: boolean;
  pages?: number;
  limit?: number;
  json?: boolean;
}

async function listRecordings(options: ListOptions): Promise<void> {
  const filter = buildFilter(options);
  const include = buildInclude(options);

  const recordings: GrainRecording[] = [];
  let cursor = options.cursor;
  let page = 0;
  const maxPages = options.all ? Number.POSITIVE_INFINITY : options.pages ?? 1;

  do {
    const body: Record<string, unknown> = {};
    if (filter) body.filter = filter;
    if (include) body.include = include;
    if (cursor) body.cursor = cursor;

    const res = await apiJson<{ cursor: string | null; recordings: GrainRecording[] }>('POST', '/v2/recordings', body);
    recordings.push(...(res.recordings || []));
    cursor = res.cursor || undefined;
    page++;

    if (options.limit && recordings.length >= options.limit) break;
  } while (cursor && page < maxPages);

  const results = options.limit ? recordings.slice(0, options.limit) : recordings;

  if (options.json) {
    output({ recordings: results, cursor: cursor ?? null }, true);
    return;
  }

  if (!results.length) {
    console.log(chalk.yellow('\nNo recordings matched.'));
    return;
  }

  console.log(chalk.bold(`\nRecordings (${results.length}):`));
  results.forEach(printRecordingLine);
  if (cursor) {
    console.log(chalk.gray(`\nMore pages available. Next: --cursor '${cursor}' (or use --all)`));
  }
}

async function getRecording(recordingId: string, options: IncludeOptions & { json?: boolean }): Promise<void> {
  const include = buildInclude(options);
  const body: Record<string, unknown> = {};
  if (include) body.include = include;

  const recording = await apiJson<GrainRecording>('POST', `/v2/recordings/${recordingId}`, body);

  if (options.json) {
    output(recording, true);
    return;
  }
  printRecordingDetail(recording);
}

function msToStamp(ms: number, separator: '.' | ','): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` +
    `${separator}${String(millis).padStart(3, '0')}`
  );
}

function segmentsToText(segments: TranscriptSegment[]): string {
  return `${segments.map(seg => `${seg.speaker}: ${seg.text}`).join('\n')}\n`;
}

function segmentsToVtt(segments: TranscriptSegment[]): string {
  const cues = segments.map(
    (seg, index) =>
      `${index + 1}\n${msToStamp(seg.start, '.')} --> ${msToStamp(seg.end, '.')}\n${seg.speaker}: ${seg.text}`
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function segmentsToSrt(segments: TranscriptSegment[]): string {
  const cues = segments.map(
    (seg, index) =>
      `${index + 1}\n${msToStamp(seg.start, ',')} --> ${msToStamp(seg.end, ',')}\n${seg.speaker}: ${seg.text}`
  );
  return `${cues.join('\n\n')}\n`;
}

/**
 * Transcript bytes for one format. `json` has no extension on the path.
 *
 * Some recordings return 406 for .vtt/.srt/.txt while the JSON transcript works
 * fine — so on 406 we pull the JSON segments and build the subtitle file locally
 * rather than failing. Identical content, and crv still gets its sidecar.
 */
async function fetchTranscript(
  recordingId: string,
  format: string
): Promise<{ text: string; synthesized: boolean }> {
  if (format !== 'json') {
    const res = await grainFetch('GET', `/v2/recordings/${recordingId}/transcript.${format}`, {
      accept: 'text/plain',
      tolerate: [406],
    });
    if (res.ok) return { text: await res.text(), synthesized: false };
  } else {
    const res = await grainFetch('GET', `/v2/recordings/${recordingId}/transcript`, {
      accept: 'application/json',
    });
    return { text: await res.text(), synthesized: false };
  }

  // 406 on the formatted endpoint — rebuild it from the JSON transcript.
  const jsonRes = await grainFetch('GET', `/v2/recordings/${recordingId}/transcript`, {
    accept: 'application/json',
  });
  const segments = JSON.parse(await jsonRes.text()) as TranscriptSegment[];

  const text =
    format === 'vtt' ? segmentsToVtt(segments) : format === 'srt' ? segmentsToSrt(segments) : segmentsToText(segments);
  return { text, synthesized: true };
}

/** `json` would collide with the metadata sidecar, so it gets its own suffix. */
function transcriptFileName(base: string, format: string): string {
  return format === 'json' ? `${base}.transcript.json` : `${base}.${format}`;
}

/** Media bytes plus the extension the response implies. */
async function fetchMedia(recordingId: string): Promise<{ buffer: Buffer; ext: string }> {
  const res = await grainFetch('GET', `/v2/recordings/${recordingId}/download`);

  const disposition = res.headers.get('content-disposition') || '';
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const fromName = filename ? /\.([a-z0-9]{2,4})$/i.exec(filename)?.[1] : undefined;

  const contentType = res.headers.get('content-type') || '';
  const ext =
    fromName ||
    (contentType.includes('audio/mpeg')
      ? 'mp3'
      : contentType.includes('audio/mp4')
        ? 'm4a'
        : contentType.includes('quicktime')
          ? 'mov'
          : 'mp4');

  // Report progress while the bytes come down. A silent multi-minute download
  // looks hung, and a caller who cannot tell working from dead relaunches —
  // which is how two runs ended up writing one recording folder.
  const total = Number(res.headers.get('content-length') || 0);
  const chunks: Buffer[] = [];
  let received = 0;
  let lastReport = Date.now();

  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      if (Date.now() - lastReport > 5000) {
        const of = total ? ` of ${formatBytes(total)}` : '';
        const pct = total ? ` (${Math.round((received / total) * 100)}%)` : '';
        console.error(chalk.gray(`  downloading… ${formatBytes(received)}${of}${pct}`));
        lastReport = Date.now();
      }
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }

  return { buffer: Buffer.concat(chunks), ext: ext.toLowerCase() };
}

/**
 * One run per recording folder. A `watch` that looks hung gets relaunched, and
 * two runs in one folder delete each other's frames — so refuse the second one
 * instead of letting them race.
 */
function acquireFolderLock(folder: string, operation: string): () => void {
  const lockPath = join(folder, '.grain-lock');
  const STALE_MS = 30 * 60 * 1000;

  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; started: string; operation: string };
      const age = Date.now() - new Date(held.started).getTime();
      const alive = (() => {
        try {
          process.kill(held.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();

      if (alive && age < STALE_MS) {
        console.error(chalk.red(`\nAnother \`grain ${held.operation}\` (pid ${held.pid}) is already working in`));
        console.error(chalk.red(`  ${folder}`));
        console.error(chalk.yellow(`Started ${Math.round(age / 1000)}s ago. Wait for it rather than running a second one —`));
        console.error(chalk.yellow('two runs in one folder overwrite each other\'s frames. Delete .grain-lock only if you'));
        console.error(chalk.yellow('are certain that process is gone.'));
        process.exit(1);
      }
      console.error(chalk.yellow(`Clearing a stale lock from pid ${held.pid} (${Math.round(age / 60000)}m old).`));
    } catch {
      console.error(chalk.yellow('Clearing an unreadable .grain-lock.'));
    }
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), operation }));
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* nothing useful to do if the lock is already gone */
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(130);
  });
  return release;
}

async function getTranscript(
  recordingId: string,
  options: { format?: string; output?: string; json?: boolean }
): Promise<void> {
  const format = options.format || 'json';
  const { text, synthesized } = await fetchTranscript(recordingId, format);
  if (synthesized) {
    console.error(
      chalk.yellow(`Grain returned 406 for .${format}; built it from the JSON transcript instead (same content).`)
    );
  }

  if (options.output) {
    writeFileSync(options.output, text);
    console.log(chalk.green(`Transcript written to ${options.output} (${formatBytes(Buffer.byteLength(text))})`));
    return;
  }

  if (format !== 'json') {
    console.log(text);
    return;
  }

  const segments = JSON.parse(text) as TranscriptSegment[];
  if (options.json) {
    output(segments, true);
    return;
  }

  if (!segments.length) {
    console.log(chalk.yellow('Transcript is empty (recording may still be processing).'));
    return;
  }
  segments.forEach(s => {
    console.log(`${chalk.gray(formatTimecode(s.start))} ${chalk.cyan(s.speaker)}: ${s.text}`);
  });
}

/**
 * Derive a watch window from the transcript, before spending a byte.
 *
 * This is the highest-leverage step in a watch and it was being improvised with
 * ad-hoc jq every time: a run that did it properly corrected its caller's
 * proposed window at BOTH ends on transcript evidence — one boundary was 50s of
 * small talk, the other would have truncated the payoff. One request, no media.
 */
async function suggestWindow(
  recordingId: string,
  options: { speakers?: string; match?: string; pad?: string; after?: string; before?: string; json?: boolean }
): Promise<void> {
  const segments = JSON.parse(
    (await fetchTranscript(recordingId, 'json')).text
  ) as TranscriptSegment[];

  if (!segments.length) {
    console.error(chalk.yellow('Transcript is empty — no window can be derived.'));
    process.exit(1);
  }

  const pad = options.pad === undefined ? 15 : Number(options.pad);
  const lower = options.after ? parseTimecode(options.after, '--after') * 1000 : 0;
  const upper = options.before ? parseTimecode(options.before, '--before') * 1000 : Number.POSITIVE_INFINITY;

  let pool = segments.filter(seg => seg.start >= lower && seg.start <= upper);

  if (options.speakers) {
    const wanted = options.speakers.split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
    pool = pool.filter(seg => wanted.some(n => (seg.speaker || '').toLowerCase().includes(n)));
  }
  if (options.match) {
    const re = new RegExp(options.match, 'i');
    pool = pool.filter(seg => re.test(seg.text || ''));
  }

  if (!pool.length) {
    console.error(chalk.yellow('No transcript segments matched those filters — widen them before extracting anything.'));
    process.exit(1);
  }

  const first = pool[0];
  const last = pool[pool.length - 1];
  const from = Math.max(0, first.start / 1000 - pad);
  const to = last.end / 1000 + pad;

  const speakerTally = new Map<string, number>();
  for (const seg of segments) {
    speakerTally.set(seg.speaker || '(unknown)', (speakerTally.get(seg.speaker || '(unknown)') || 0) + 1);
  }

  if (options.json) {
    output(
      {
        from_sec: Number(from.toFixed(3)),
        to_sec: Number(to.toFixed(3)),
        from: timecodeSlug(from).replace(/-/g, ':'),
        to: timecodeSlug(to).replace(/-/g, ':'),
        matched_segments: pool.length,
        span_sec: Number((to - from).toFixed(3)),
        first_match: { start_sec: first.start / 1000, speaker: first.speaker, text: first.text },
        last_match: { start_sec: last.start / 1000, speaker: last.speaker, text: last.text },
        speakers: [...speakerTally.entries()].map(([speaker, segments]) => ({ speaker, segments })),
      },
      true
    );
    return;
  }

  const span = to - from;
  console.log(chalk.bold(`\nSuggested window: ${timecodeSlug(from).replace(/-/g, ':')} → ${timecodeSlug(to).replace(/-/g, ':')}`));
  console.log(chalk.gray(`  --from ${Math.round(from)} --to ${Math.round(to)}   (${formatDuration(span * 1000)}, ${pool.length} matching segment(s), ${pad}s padding)`));

  console.log(chalk.bold('\nEvidence at the boundaries — check these before you spend anything:'));
  console.log(`  ${chalk.cyan('opens')}  ${timecodeSlug(first.start / 1000).replace(/-/g, ':')}  ${first.speaker}: ${(first.text || '').slice(0, 120)}`);
  console.log(`  ${chalk.cyan('closes')} ${timecodeSlug(last.end / 1000).replace(/-/g, ':')}  ${last.speaker}: ${(last.text || '').slice(0, 120)}`);

  console.log(chalk.bold('\nSpeakers in this recording:'));
  [...speakerTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([speaker, count]) => console.log(`  ${speaker} ${chalk.gray(`(${count} segments)`)}`));

  console.log(
    chalk.gray(
      '\nA boundary that reads like small talk means the window is too wide; a match at the very\n' +
        'last segment means it is probably too narrow. Adjust before extracting, not after.'
    )
  );
}

async function downloadRecording(recordingId: string, options: { output?: string }): Promise<void> {
  const { buffer, ext } = await fetchMedia(recordingId);
  const target = options.output || `grain-${recordingId}.${ext}`;
  writeFileSync(target, buffer);
  console.log(chalk.green(`Downloaded ${formatBytes(buffer.byteLength)} to ${target}`));
}

interface ExportOptions extends IncludeOptions {
  dir?: string;
  formats?: string;
  media?: boolean;
  metadata?: boolean;
  force?: boolean;
  json?: boolean;
}

interface ExportedRecording {
  recording: GrainRecording;
  folder: string;
  base: string;
  /** The media file on disk, whether written this run or already present. */
  mediaFile?: string;
  files: string[];
  skipped: string[];
}

function parseFormats(raw: string | undefined, fallback: string): string[] {
  const formats = (raw ?? fallback)
    .split(',')
    .map(f => f.trim().toLowerCase())
    .filter(Boolean);

  for (const format of formats) {
    if (!(TRANSCRIPT_FORMATS as readonly string[]).includes(format)) {
      console.error(chalk.red(`Unknown transcript format: ${format}`));
      console.error(chalk.yellow(`Valid formats: ${TRANSCRIPT_FORMATS.join(', ')}`));
      process.exit(1);
    }
  }
  return formats;
}

/**
 * Fetch one recording's artifacts into its own folder under the storage root.
 * Media and each transcript format are separate endpoints, so this costs
 * 1 + (media ? 1 : 0) + formats.length requests.
 */
async function exportOne(
  recordingId: string,
  formats: string[],
  options: ExportOptions
): Promise<ExportedRecording> {
  const include = buildInclude(options);
  const recording = await apiJson<GrainRecording>(
    'POST',
    `/v2/recordings/${recordingId}`,
    include ? { include } : {}
  );

  const base = recordingFolderName(recording);
  const folder = join(storageRoot(options.dir), base);
  mkdirSync(folder, { recursive: true });
  const releaseLock = acquireFolderLock(folder, 'export');

  const files: string[] = [];
  const skipped: string[] = [];

  const write = (name: string, data: string | Buffer): void => {
    const target = join(folder, name);
    if (existsSync(target) && !options.force) {
      skipped.push(name);
      return;
    }
    writeFileSync(target, data);
    files.push(name);
  };

  if (options.metadata !== false) {
    write(`${base}.json`, JSON.stringify(recording, null, 2));
  }

  let mediaFile: string | undefined;
  if (options.media !== false) {
    // Check every media extension before fetching — the point of skipping is to
    // avoid re-downloading gigabytes, so the existence test comes first.
    const existingMedia = MEDIA_EXTENSIONS.map(ext => `${base}.${ext}`).find(name =>
      existsSync(join(folder, name))
    );
    if (existingMedia && !options.force) {
      skipped.push(existingMedia);
      mediaFile = join(folder, existingMedia);
    } else {
      const { buffer, ext } = await fetchMedia(recording.id);
      write(`${base}.${ext}`, buffer);
      mediaFile = join(folder, `${base}.${ext}`);
    }
  }

  for (const format of formats) {
    const name = transcriptFileName(base, format);
    // Existence check before the request — a re-run should cost nothing.
    if (existsSync(join(folder, name)) && !options.force) {
      skipped.push(name);
      continue;
    }
    const { text, synthesized } = await fetchTranscript(recording.id, format);
    if (synthesized && !options.json) {
      console.error(chalk.yellow(`  Grain returned 406 for .${format} — built from the JSON transcript instead`));
    }
    write(name, text);
  }

  releaseLock();
  return { recording, folder, base, mediaFile, files, skipped };
}

function printExported(entry: ExportedRecording): void {
  console.log(chalk.cyan(`\n${entry.recording.title || '(untitled)'}`));
  console.log(chalk.gray(`  ${entry.folder}`));
  entry.files.forEach(f => console.log(chalk.green(`  + ${f}`)));
  entry.skipped.forEach(f => console.log(chalk.yellow(`  = ${f} (exists — pass --force to overwrite)`)));
}

async function exportRecordings(recordingIds: string[], options: ExportOptions): Promise<void> {
  const formats = parseFormats(options.formats, 'srt');
  const root = storageRoot(options.dir);
  const exported: ExportedRecording[] = [];

  for (const recordingId of recordingIds) {
    exported.push(await exportOne(recordingId, formats, options));
  }

  if (options.json) {
    output(
      {
        storageRoot: root,
        recordings: exported.map(e => ({
          id: e.recording.id,
          title: e.recording.title,
          folder: e.folder,
          mediaFile: e.mediaFile,
          files: e.files,
          skipped: e.skipped,
        })),
      },
      true
    );
    return;
  }

  exported.forEach(printExported);
  console.log(chalk.gray(`\nStorage root: ${root}`));
}

// ============================================================================
// `recording watch` — export, then hand the folder to claude-real-video (crv)
//
// crv picks up a sidecar .vtt/.srt sitting next to the media file with the same
// stem, which is exactly what exportOne writes — so no Whisper pass is needed.
// ============================================================================

/** Accepts `90`, `1:30`, `01:30.500`, `1:02:03` → seconds. */
function parseTimecode(value: string, label: string): number {
  const parts = value.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || Number.isNaN(Number(p)))) {
    console.error(chalk.red(`Invalid ${label}: ${value}`));
    console.error(chalk.yellow('Use seconds (90), mm:ss (1:30), or hh:mm:ss (0:01:30.5)'));
    process.exit(1);
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** `1h02m03s` → `01-02-03`, for filenames. */
function timecodeSlug(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join('-');
}

function formatClock(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * crv 0.10.0 extracts at `--frame-width` (issue #17), so `frames/` is already at
 * whatever resolution we asked for — the second ffmpeg pass this used to run is
 * gone. What remains is the naming problem it also solved.
 *
 * crv numbers frames per run, so `frame_051.jpg` means a different moment in
 * every window, and a report citing it has to carry the window offset in its
 * head. Getting that offset wrong is exactly how a real report ended up citing
 * 00:38:08 for a frame that was at 30:32. So mirror the frames under names that
 * cannot be misaligned — `t00-38-08.jpg` says what it is — and write the maps
 * that let a `frame_NNN` citation still be resolved.
 *
 * The mirror is hardlinked, not copied: same bytes, one inode, no second copy of
 * a 3840px frame set on disk. Falls back to a copy if the link cannot be made.
 */
function mapFramesByTime(
  analysisDir: string,
  force: boolean,
  link: boolean
): { dir?: string; linked: number; skipped: number } | undefined {
  const framesJson = join(analysisDir, 'frames.json');
  if (!existsSync(framesJson)) {
    console.error(chalk.yellow(`No frames.json in ${analysisDir} — skipping the frame-time maps`));
    return undefined;
  }

  const data = JSON.parse(readFileSync(framesJson, 'utf8')) as {
    frames: { file: string; timestamp_sec: number }[];
  };
  const frames = data.frames || [];

  // crv 0.10.0 reports source timecodes even inside a --from/--to window
  // ("a window shifts the analysis, not the clock"), so timestamp_sec needs no
  // offset applied to it. That offset argument is what this function used to
  // carry, and it is gone along with the clip that made it necessary.
  // A timecode slug is second-resolution, and crv keeps frames closer together
  // than that — 58 frames of a one-minute window collapsed onto 54 names, and
  // the four that collided were silently dropped as "already present". So count
  // the slugs first and give every member of a collision its milliseconds. A
  // bare tHH-MM-SS name therefore always means exactly one frame.
  const slugCounts = new Map<string, number>();
  for (const frame of frames) {
    const slug = timecodeSlug(frame.timestamp_sec);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  const map: string[] = ['crv_frame\tsource_timecode\tsource_sec\tby_time_file'];
  let linked = 0;
  let skipped = 0;
  const dir = join(analysisDir, 'frames-by-time');
  if (link) mkdirSync(dir, { recursive: true });

  for (const frame of frames) {
    const sourceSec = frame.timestamp_sec;
    const slug = timecodeSlug(sourceSec);
    const ms = String(Math.round((sourceSec % 1) * 1000)).padStart(3, '0');
    const name = `t${slug}${(slugCounts.get(slug) ?? 0) > 1 ? `-${ms}` : ''}.jpg`;
    map.push(`${frame.file}\t${slug.replace(/-/g, ':')}\t${sourceSec.toFixed(3)}\t${link ? name : '(not linked)'}`);
    if (!link) continue;

    const target = join(dir, name);
    const source = join(analysisDir, 'frames', frame.file);
    if (existsSync(target)) {
      if (!force) {
        skipped++;
        continue;
      }
      rmSync(target, { force: true });
    }
    if (!existsSync(source)) {
      console.error(chalk.yellow(`crv listed ${frame.file} but it is not in frames/ — skipping`));
      continue;
    }
    try {
      linkSync(source, target);
    } catch {
      copyFileSync(source, target);
    }
    linked++;
  }

  writeFileSync(join(analysisDir, 'frame-map.tsv'), `${map.join('\n')}\n`);

  // Which source times each contact sheet covers. Grids hold 9 frames in order,
  // so this is derivable — but deriving it by hand every run is the difference
  // between opening 5 grids and opening 20. A run that built this map found the
  // entire 15-minute screen share lived in grids 17-19.
  const perGrid = 9;
  const gridLines = ['grid\tfirst_source\tlast_source\tframes'];
  const kept = frames.map((f, i) => ({ i, at: timecodeSlug(f.timestamp_sec).replace(/-/g, ':') }));
  for (let g = 0; g * perGrid < kept.length; g++) {
    const slice = kept.slice(g * perGrid, (g + 1) * perGrid);
    gridLines.push(
      `grid_${String(g + 1).padStart(2, '0')}.jpg\t${slice[0].at}\t${slice[slice.length - 1].at}\t${slice.length}`
    );
  }
  writeFileSync(join(analysisDir, 'grid-map.tsv'), `${gridLines.join('\n')}\n`);

  return { dir: link ? dir : undefined, linked, skipped };
}

/** Width and height of a media file in pixels; zeros if ffprobe can't say. */
function sourceDimensions(mediaFile: string): { width: number; height: number } {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mediaFile],
    { encoding: 'utf8' }
  );
  const [width, height] = (probe.stdout || '').trim().split(',').map(Number);
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

/** Long edge of a media file in pixels, or 0 if ffprobe can't say. */
function sourceLongEdgeProbe(mediaFile: string): number {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mediaFile],
    { encoding: 'utf8' }
  );
  const [w, h] = (probe.stdout || '').trim().split(',').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? Math.max(w, h) : 0;
}

/**
 * Arbitrary-timestamp frame extraction — the escape hatch from crv's dedup.
 *
 * crv discards near-identical frames, which is right for talking heads and wrong
 * for a spreadsheet being typed into: the incremental edits ARE the content, and
 * they sit between the frames crv keeps. This pulls exact seconds out of the
 * full-resolution media, optionally cropped to the region that matters and
 * upscaled, which is what makes small on-screen text readable.
 *
 * Timestamps are always source-video time — this reads the full media, never a
 * clip, so there is no offset to reason about.
 */
async function extractFrames(
  recordingId: string,
  options: {
    at?: string;
    every?: string;
    from?: string;
    to?: string;
    crop?: string;
    cropInGrid?: string;
    gridCellWidth?: string;
    upscale?: string;
    maxDim?: string;
    dir?: string;
    out?: string;
    force?: boolean;
    json?: boolean;
  }
): Promise<void> {
  const entry = await exportOne(recordingId, [], { ...options, media: true, metadata: false });
  if (!entry.mediaFile) {
    console.error(chalk.red('No media file available to extract from'));
    process.exit(1);
  }

  const seconds: number[] = [];
  for (const raw of (options.at || '').split(',').map(v => v.trim()).filter(Boolean)) {
    seconds.push(parseTimecode(raw, '--at'));
  }
  if (options.every) {
    const step = Number(options.every);
    if (!Number.isFinite(step) || step <= 0) {
      console.error(chalk.red(`--every must be a positive number of seconds, got: ${options.every}`));
      process.exit(1);
    }
    const from = options.from ? parseTimecode(options.from, '--from') : 0;
    const to = options.to
      ? parseTimecode(options.to, '--to')
      : (entry.recording.duration_ms || 0) / 1000;
    if (to <= from) {
      console.error(chalk.red('--to must be after --from'));
      process.exit(1);
    }
    for (let t = from; t <= to; t += step) seconds.push(Math.round(t * 1000) / 1000);
  }

  if (!seconds.length) {
    console.error(chalk.red('Nothing to extract — pass --at <seconds,...> or --every <n> with --from/--to'));
    process.exit(1);
  }

  const filters: string[] = [];

  // Crop geometry is the hardest manual step: coordinates have to be in SOURCE
  // pixels, but the only thing you have looked at is a 480px-wide grid cell.
  // --crop-in-grid takes the numbers measured in that cell and scales them.
  let crop = options.crop;
  if (options.cropInGrid) {
    const cell = options.cropInGrid.split(':').map(Number);
    if (cell.length !== 4 || cell.some(n => !Number.isFinite(n))) {
      console.error(chalk.red(`--crop-in-grid needs W:H:X:Y measured inside a grid cell, got: ${options.cropInGrid}`));
      process.exit(1);
    }
    const cellWidth = Number(options.gridCellWidth || 480);
    const sourceWidth = sourceDimensions(entry.mediaFile).width;
    if (!sourceWidth) {
      console.error(chalk.red('Cannot read the source width with ffprobe, so --crop-in-grid cannot be scaled.'));
      console.error(chalk.yellow('Pass --crop W:H:X:Y in source pixels instead.'));
      process.exit(1);
    }
    // Grids are laid out by WIDTH, so the factor is source width ÷ cell width.
    // It is not a constant: 1280px source → 2.667, 1920px → 4.0. Hardcoding it
    // would silently mis-frame every non-720p recording — extracting fine, just
    // of the wrong region, which reads downstream as "the content wasn't there".
    const factor = sourceWidth / cellWidth;
    crop = cell.map(n => Math.round(n * factor)).join(':');
    console.log(
      chalk.gray(`--crop-in-grid ${options.cropInGrid} × ${factor.toFixed(3)} (${sourceWidth}÷${cellWidth}) → --crop ${crop}`)
    );
  }
  if (crop) filters.push(`crop=${crop}`);
  if (options.upscale) {
    const factor = Number(options.upscale);
    if (!Number.isFinite(factor) || factor <= 0) {
      console.error(chalk.red(`--upscale must be a positive number, got: ${options.upscale}`));
      process.exit(1);
    }
    filters.push(`scale=iw*${factor}:ih*${factor}:flags=lanczos`);
  }

  // Claude's vision limits make anything past ~2000px wasted work: images are
  // downscaled to the model's long-edge/visual-token cap before it sees them, and
  // once a request carries more than 20 images (history and tool results count)
  // any image over 2000px on either side is REJECTED rather than downscaled.
  const maxDim = options.maxDim === undefined ? 2000 : Number(options.maxDim);
  if (!Number.isFinite(maxDim) || maxDim < 0) {
    console.error(chalk.red(`--max-dim must be a non-negative number, got: ${options.maxDim}`));
    process.exit(1);
  }
  const sourceLongEdge = sourceLongEdgeProbe(entry.mediaFile);

  // Decide the clamp on the geometry this run will actually produce, not on
  // "an upscale was requested" — a run that clamps nothing must not claim it
  // clamped, and one that silently halves a requested upscale must say so.
  const cropLongEdge = crop ? Math.max(...crop.split(':').slice(0, 2).map(Number)) : sourceLongEdge;
  const upscaleFactor = options.upscale ? Number(options.upscale) : 1;
  const producedLongEdge = cropLongEdge * upscaleFactor;
  const needsClamp = maxDim > 0 && producedLongEdge > maxDim;

  if (needsClamp) {
    // The commas inside min() must reach ffmpeg backslash-escaped, or it reads
    // them as filterchain separators and dies with "No option name near 'min(ih'".
    // In a JS template literal that means `\\,` — a single `\,` collapses to a
    // bare comma and every extraction fails.
    filters.push(
      `scale=w=min(iw\\,${maxDim}):h=min(ih\\,${maxDim}):force_original_aspect_ratio=decrease:flags=lanczos`
    );
  }

  const dir = options.out || join(entry.folder, 'frames-manual');
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  // A crop is part of a frame's identity. Naming by timecode alone let two
  // different crops of one moment overwrite each other mid-run under --force,
  // which silently invalidates any citation made before the overwrite.
  const variant = [
    crop ? `c${crop.replace(/[:]/g, 'x')}` : '',
    options.upscale ? `x${options.upscale}` : '',
  ]
    .filter(Boolean)
    .join('_');

  for (const t of [...new Set(seconds)].sort((a, b) => a - b)) {
    const name = variant ? `t${timecodeSlug(t)}_${variant}.jpg` : `t${timecodeSlug(t)}.jpg`;
    const target = join(dir, name);
    if (existsSync(target) && !options.force) {
      skipped.push(name);
      continue;
    }
    const args = ['-loglevel', 'error', '-y', '-ss', String(t), '-i', entry.mediaFile];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-frames:v', '1', '-q:v', '2', target);

    const run = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    if (run.error) {
      console.error(chalk.red('Cannot run `ffmpeg` — required for frame extraction'));
      console.error(chalk.yellow('Install it with: brew install ffmpeg'));
      process.exit(1);
    }
    if (run.status !== 0) {
      console.error(chalk.yellow(`ffmpeg could not extract ${name} — continuing`));
      failed.push(name);
      continue;
    }
    written.push(name);
  }

  // A run that extracts nothing must not look like a successful no-op: every
  // frame failing used to print "0 frame(s)" and exit 0, which reads as "there
  // was nothing to do" rather than "the filter was malformed".
  if (!written.length && failed.length) {
    console.error(chalk.red(`\nExtraction failed for all ${failed.length} frame(s) — no images written.`));
    console.error(chalk.yellow('The ffmpeg output above carries the reason. Check --crop / --upscale / --max-dim values.'));
    process.exit(1);
  }

  if (options.json) {
    output({ folder: entry.folder, dir, media: entry.mediaFile, written, skipped, failed }, true);
    return;
  }

  console.log(chalk.green(`\n${written.length} frame(s) → ${dir}`));
  if (skipped.length) console.log(chalk.yellow(`${skipped.length} already present (pass --force to overwrite)`));
  console.log(chalk.gray('Filenames are source-video timecodes, so citations need no offset.'));
  if (needsClamp) {
    console.log(chalk.gray(`Long edge clamped to ${maxDim}px — past that Claude downscales anyway.`));
    if (options.upscale) {
      console.log(
        chalk.yellow(
          `  --upscale ${options.upscale} would have reached ${Math.round(producedLongEdge)}px, so the effective ` +
            `factor is ${(maxDim / cropLongEdge).toFixed(2)}. Pass --max-dim 0 to get the full ${options.upscale}x.`
        )
      );
    }
  } else if (producedLongEdge) {
    console.log(chalk.gray(`Output long edge ${Math.round(producedLongEdge)}px; under the ${maxDim || 'disabled'} cap, no clamp applied.`));
  }
  if (!filters.length) {
    console.log(
      chalk.gray('Small on-screen text still unreadable? Re-run with --crop W:H:X:Y --upscale 3 for that region.')
    );
  }
}

interface WatchOptions extends ExportOptions {
  why?: string;
  out?: string;
  maxFrames?: string;
  scene?: string;
  fpsFloor?: string;
  crvArgs?: string;
  crv?: string;
  skipExport?: boolean;
  from?: string;
  to?: string;
  grid?: boolean;
  fullRes?: boolean;
  frameWidth?: string;
}

/**
 * The installed claude-real-video version, or undefined when it cannot be read.
 *
 * crv exposes no `--version` and no `__version__`, so the only honest source is
 * the installed distribution's metadata. Its launcher is a Python console script
 * whose shebang names the interpreter of the environment it lives in — pipx venv,
 * virtualenv, or system — so ask that interpreter, not whichever `python3` is on
 * PATH, which in a pipx install knows nothing about the package.
 */
function crvVersion(binary: string): string | undefined {
  const resolved = spawnSync('command', ['-v', binary], { encoding: 'utf8', shell: true });
  const path = (resolved.stdout || '').trim();
  if (!path) return undefined;

  let shebang = '';
  try {
    shebang = readFileSync(path, 'utf8').split('\n', 1)[0] || '';
  } catch {
    return undefined; // a compiled or non-readable launcher
  }
  const interpreter = shebang.startsWith('#!') ? shebang.slice(2).trim().split(/\s+/).pop() : undefined;
  if (!interpreter || !/python/.test(interpreter)) return undefined;

  const probe = spawnSync(
    interpreter,
    ['-c', "import importlib.metadata as m; print(m.version('claude-real-video'))"],
    { encoding: 'utf8' }
  );
  const version = (probe.stdout || '').trim();
  return /^\d+\.\d+/.test(version) ? version : undefined;
}

/** True when `version` is at least `minimum`, comparing numerically per part. */
function atLeastVersion(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).map(n => Number(n) || 0);
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] || 0, b[i] || 0];
    if (x !== y) return x > y;
  }
  return true;
}

const MIN_CRV = '0.10.1';

function requireCrv(binary: string): void {
  const probe = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  if (probe.error) {
    console.error(chalk.red(`Cannot run \`${binary}\` — claude-real-video is not installed or not on PATH`));
    console.error(chalk.yellow('Install it with:  pip install "claude-real-video[whisper]"'));
    console.error(chalk.yellow('It also needs ffmpeg/ffprobe on PATH (brew install ffmpeg).'));
    process.exit(1);
  }

  // `watch` passes --from and --frame-width, both of which arrived in 0.10.0.
  // An older crv would fail inside argparse with a message about this CLI's
  // flags, which reads like a bug here rather than an install to update.
  const help = `${probe.stdout || ''}${probe.stderr || ''}`;
  if (!help.includes('--frame-width')) {
    console.error(chalk.red(`\`${binary}\` is older than 0.10.0 — it has no --frame-width or --from`));
    console.error(chalk.yellow('Upgrade it with:  pipx upgrade claude-real-video   (or pip install -U claude-real-video)'));
    process.exit(1);
  }

  // 0.10.1 is a behaviour fix, not a new flag: `--to` keeps frame timestamps
  // (upstream #19/#21) and a sidecar transcript is clipped to the window
  // (#20/#23). `watch` now relies on both instead of working around them, and
  // 0.10.0 would silently produce t=None frames and a whole-call transcript. No
  // flag distinguishes the two, so read the version.
  const version = crvVersion(binary);
  if (version && !atLeastVersion(version, MIN_CRV)) {
    console.error(chalk.red(`\`${binary}\` is ${version} — ${MIN_CRV} or newer is required`));
    console.error(
      chalk.yellow(
        `In ${version}, --to destroys every frame timestamp and the transcript ignores the window.\n` +
          'Upgrade it with:  pipx upgrade claude-real-video   (or pip install -U claude-real-video)'
      )
    );
    process.exit(1);
  }
  if (!version) {
    console.error(
      chalk.yellow(
        `Cannot read the \`${binary}\` version, so ${MIN_CRV} cannot be confirmed — continuing.\n` +
          `If frames come back without timestamps, or a windowed transcript covers the whole call,\n` +
          `the install is older than ${MIN_CRV}: pipx upgrade claude-real-video`
      )
    );
  }
}

async function watchRecordings(recordingIds: string[], options: WatchOptions): Promise<void> {
  const binary = options.crv || process.env.GRAIN_CRV_BIN || 'crv';
  requireCrv(binary);

  const formats = parseFormats(options.formats, 'srt');

  const window =
    options.from || options.to
      ? {
          from: options.from ? parseTimecode(options.from, '--from') : 0,
          to: options.to ? parseTimecode(options.to, '--to') : undefined,
        }
      : undefined;
  if (window && window.to !== undefined && window.to <= window.from) {
    console.error(chalk.red(`--to (${options.to}) must be after --from (${options.from ?? '0'})`));
    process.exit(1);
  }

  const watched: {
    id: string;
    title: string;
    folder: string;
    media?: string;
    transcript?: string;
    analysis: string;
    byTimeFrames?: string;
    frameWidth?: number;
  }[] = [];

  for (const recordingId of recordingIds) {
    let entry: ExportedRecording;

    if (options.skipExport) {
      // Reuse a folder a previous export already filled.
      const recording = await apiJson<GrainRecording>('POST', `/v2/recordings/${recordingId}`, {});
      const base = recordingFolderName(recording);
      const folder = join(storageRoot(options.dir), base);
      const mediaFile = MEDIA_EXTENSIONS.map(ext => join(folder, `${base}.${ext}`)).find(f => existsSync(f));
      if (!mediaFile) {
        console.error(chalk.red(`No exported media found in ${folder}`));
        console.error(chalk.yellow('Drop --skip-export to download it first.'));
        process.exit(1);
      }
      entry = { recording, folder, base, mediaFile, files: [], skipped: [] };
    } else {
      entry = await exportOne(recordingId, formats, { ...options, media: true });
    }

    if (!entry.mediaFile) {
      console.error(chalk.red(`No media file for ${entry.recording.id} — cannot analyze`));
      process.exit(1);
    }

    // Grain already produced a transcript, and crv prefers a same-stem .vtt/.srt
    // sidecar over running Whisper — so no flag is needed to avoid transcribing.
    const sidecar = ['vtt', 'srt'].find(f => existsSync(join(entry.folder, `${entry.base}.${f}`)));

    // A window never cuts the media — crv takes --from/--to itself and reports
    // source timecodes through it. The suffix still separates one window's
    // analysis directory from another's.
    const windowSuffix = window
      ? `_${timecodeSlug(window.from)}_${window.to === undefined ? 'end' : timecodeSlug(window.to)}`
      : '';

    // --frame-width (crv 0.10.0, issue #17) replaces the second ffmpeg pass this
    // used to run. --full-res means "whatever the source actually is", so probe
    // it; an explicit --frame-width wins over the probe.
    let frameWidth = options.frameWidth ? Number(options.frameWidth) : undefined;
    if (frameWidth === undefined && options.fullRes) {
      const probed = sourceDimensions(entry.mediaFile).width;
      if (!probed) {
        console.error(chalk.red(`ffprobe could not read the frame width of ${basename(entry.mediaFile)}`));
        console.error(chalk.yellow('Pass an explicit --frame-width <px> instead of --full-res.'));
        process.exit(1);
      }
      frameWidth = probed;
      if (!options.json) {
        console.log(chalk.gray(`  --full-res → --frame-width ${frameWidth} (source width of ${basename(entry.mediaFile)})`));
      }
    }

    let analysisDir = options.out || join(entry.folder, `crv-out${windowSuffix}`);

    // crv refuses to write into a directory that already holds an analysis and
    // suggests --overwrite. Under concurrency that is the destructive answer: it
    // wipes frames a live run is still selecting from. So never pass --overwrite —
    // reuse a complete analysis, and side-step an incomplete one into a fresh dir.
    const manifestPath = join(analysisDir, 'MANIFEST.txt');
    if (existsSync(analysisDir) && !options.force) {
      if (existsSync(manifestPath)) {
        if (!options.json) {
          console.log(chalk.yellow(`\nReusing the analysis already in ${analysisDir} (pass --force to redo it).`));
        }
        const hires = mapFramesByTime(analysisDir, false, Boolean(options.fullRes || options.frameWidth));
        watched.push({
          id: entry.recording.id,
          title: entry.recording.title,
          folder: entry.folder,
          media: entry.mediaFile,
          transcript: sidecar ? join(entry.folder, `${entry.base}.${sidecar}`) : undefined,
          analysis: analysisDir,
          byTimeFrames: hires?.dir,
          frameWidth,
        });
        continue;
      }

      // Populated but no manifest: either a crashed run or one still going in
      // another process. Either way, do not touch it.
      let suffix = 2;
      while (existsSync(`${analysisDir}-${suffix}`)) suffix++;
      console.error(
        chalk.yellow(
          `\n${analysisDir} holds an incomplete analysis (no MANIFEST.txt) — another run may still be writing it.\n` +
            `Writing this one to ${analysisDir}-${suffix} instead of overwriting.`
        )
      );
      analysisDir = `${analysisDir}-${suffix}`;
    }

    const args = [entry.mediaFile, '-o', analysisDir];
    if (options.grid !== false) args.push('--grid');
    if (options.why) args.push('--why', options.why);
    if (options.maxFrames) args.push('--max-frames', options.maxFrames);
    if (options.scene) args.push('--scene', options.scene);
    if (options.fpsFloor) args.push('--fps-floor', options.fpsFloor);
    // Both bounds go to crv (0.10.1 — upstream #21): frame timestamps survive
    // --to, and they stay on the source clock inside the window.
    if (window && window.from > 0) args.push('--from', String(window.from));
    if (window?.to !== undefined) args.push('--to', String(window.to));
    if (frameWidth !== undefined) args.push('--frame-width', String(frameWidth));
    if (options.crvArgs) args.push(...options.crvArgs.split(' ').filter(Boolean));

    if (!options.json) {
      printExported(entry);
      if (window) {
        const span = `${formatClock(window.from)} → ${window.to === undefined ? 'end' : formatClock(window.to)}`;
        console.log(chalk.gray(`  window ${span} — timestamps stay on the source clock`));
      }
      console.log(
        chalk.gray(
          sidecar
            ? `  transcript sidecar ${entry.base}.${sidecar} present — crv uses it instead of running Whisper`
            : '  no transcript sidecar — crv will transcribe the audio with Whisper'
        )
      );
      console.log(chalk.bold(`\n${binary} ${args.join(' ')}\n`));
    }

    const run = spawnSync(binary, args, { stdio: options.json ? 'ignore' : 'inherit' });
    if (run.status !== 0) {
      console.error(chalk.red(`${binary} exited with status ${run.status ?? 'unknown'}`));
      process.exit(run.status || 1);
    }

    // A crv run that dies after extraction leaves a populated frames/ with no
    // MANIFEST.txt and an empty grids/ — which looks like success on disk. Say so.
    if (!existsSync(join(analysisDir, 'MANIFEST.txt'))) {
      console.error(
        chalk.red(`\ncrv exited 0 but wrote no MANIFEST.txt in ${analysisDir} — the analysis is incomplete.`)
      );
      console.error(
        chalk.yellow(
          'frames/ may be populated without an index over it. Re-run with --force, or extract\n' +
            'specific timestamps directly: grain recording frames <id> --at <seconds> --crop … --upscale 3'
        )
      );
      process.exit(1);
    }

    const hires = mapFramesByTime(analysisDir, Boolean(options.force), Boolean(options.fullRes || options.frameWidth));
    if (hires?.dir && !options.json) {
      console.log(
        chalk.green(
          `\nFrames by source time: ${hires.linked} linked` +
            `${hires.skipped ? `, ${hires.skipped} already present` : ''} → ${hires.dir}`
        )
      );
    }

    watched.push({
      id: entry.recording.id,
      title: entry.recording.title,
      folder: entry.folder,
      media: entry.mediaFile,
      transcript: sidecar ? join(entry.folder, `${entry.base}.${sidecar}`) : undefined,
      analysis: analysisDir,
      byTimeFrames: hires?.dir,
      frameWidth,
    });
  }

  if (options.json) {
    output({ watched }, true);
    return;
  }

  console.log(chalk.bold('\nReady to read:'));
  watched.forEach(w => {
    console.log(chalk.cyan(`\n${w.title || '(untitled)'}`));
    console.log(`  manifest:   ${join(w.analysis, 'MANIFEST.txt')}`);
    const grids = join(w.analysis, 'grids');
    if (existsSync(grids)) console.log(`  grids:      ${grids}/`);
    // crv writes transcript.txt only when it produced one; fall back to the
    // exported sidecar so there is always a transcript path to open.
    const crvTranscript = join(w.analysis, 'transcript.txt');
    console.log(`  transcript: ${existsSync(crvTranscript) ? crvTranscript : w.transcript || '(none)'}`);
    console.log(
      `  keyframes:  ${join(w.analysis, 'frames')}/  ` +
        chalk.gray(w.frameWidth ? `(${w.frameWidth}px — crv --frame-width)` : '(640px — crv default)')
    );
    if (w.byTimeFrames) {
      console.log(`  by time:    ${w.byTimeFrames}/  ${chalk.gray('(the same frames, hardlinked under absolute source timecodes)')}`);
    }
    console.log(chalk.gray(`  frame map:  ${join(w.analysis, 'frame-map.tsv')}  (crv frame_NNN → source time)`));
    console.log(chalk.gray(`  grid map:   ${join(w.analysis, 'grid-map.tsv')}  (which source times each contact sheet covers)`));
  });
  console.log(
    chalk.gray(
      '\nRead MANIFEST.txt first (frame index + transcript), then the 3x3 contact sheets in\n' +
        'grids/, and open individual frames/ only for detail. Cite timestamps in the answer.'
    )
  );
}

async function uploadRecording(
  filePath: string,
  options: { userId?: string; json?: boolean }
): Promise<void> {
  const stats = statSync(filePath);
  const filename = basename(filePath);
  if (!/\.(mov|mp4|mp3|m4a)$/i.test(filename)) {
    console.error(chalk.red(`Unsupported format: ${filename}`));
    console.error(chalk.yellow('Grain accepts .mov, .mp4, .mp3, .m4a'));
    process.exit(1);
  }

  const body: Record<string, unknown> = { filename };
  if (options.userId) body.user_id = options.userId;

  const ticket = await apiJson<{ url: string; uuid: string; max_duration_sec: number; max_upload_bytes: number }>(
    'POST',
    '/v2/recordings/upload',
    body
  );

  if (stats.size > ticket.max_upload_bytes) {
    console.error(
      chalk.red(
        `File is ${formatBytes(stats.size)}, over the workspace limit of ${formatBytes(ticket.max_upload_bytes)}`
      )
    );
    process.exit(1);
  }

  // The generated URL is pre-signed: it takes the raw bytes and no auth headers.
  const put = await fetch(ticket.url, {
    method: 'PUT',
    body: readFileSync(filePath),
  });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    console.error(chalk.red(`Upload PUT failed: ${put.status} ${put.statusText}`));
    if (text) console.error(chalk.gray(text.slice(0, 1000)));
    process.exit(1);
  }

  if (options.json) {
    output({ uuid: ticket.uuid, filename, bytes: stats.size, uploaded: true }, true);
    return;
  }

  console.log(chalk.green(`Uploaded ${filename} (${formatBytes(stats.size)})`));
  console.log(`  upload id: ${ticket.uuid}`);
  console.log(
    chalk.yellow(
      '  Grain still has to process the file. Completion (and the resulting recording_id)\n' +
        '  is delivered only to an `upload_status` hook — there is no status endpoint.\n' +
        '  Register one with: grain hook create <url> --type upload_status'
    )
  );
}

async function updateRecording(recordingId: string, options: { title: string; json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>('PATCH', `/v2/recordings/${recordingId}`, { title: options.title });
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Renamed ${recordingId} → "${options.title}"`));
}

async function addTag(recordingId: string, tag: string, options: { json?: boolean }): Promise<void> {
  if (!TAG_REGEX.test(tag)) {
    console.error(chalk.red(`Invalid tag: ${tag}`));
    console.error(chalk.yellow('Tags are letters/digits separated by dashes, e.g. "customer-call". No spaces.'));
    process.exit(1);
  }
  const res = await apiJson<{ success: boolean }>('PUT', `/v2/recordings/${recordingId}/tags`, { tag });
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Tagged ${recordingId} with "${tag}"`));
}

async function removeTag(recordingId: string, tag: string, options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>(
    'DELETE',
    `/v2/recordings/${recordingId}/tags/${encodeURIComponent(tag)}`
  );
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Removed tag "${tag}" from ${recordingId}`));
}

async function shareWithUser(recordingId: string, userId: string, options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>('PUT', `/v2/recordings/${recordingId}/users`, { user_id: userId });
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Shared ${recordingId} with user ${userId}`));
}

async function unshareWithUser(recordingId: string, userId: string, options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>('DELETE', `/v2/recordings/${recordingId}/users/${userId}`);
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Unshared ${recordingId} from user ${userId}`));
}

/**
 * The docs disagree with themselves on team sharing: the heading says
 * `PUT .../teams/:team_id`, the curl example says `PUT .../teams` with the id in
 * the body. Send the body form (which mirrors user sharing) and fall back to the
 * path form if the route 404/405s.
 */
async function shareWithTeam(recordingId: string, teamId: string, options: { json?: boolean }): Promise<void> {
  const url = `${BASE_URL}${API_PREFIX}/v2/recordings/${recordingId}/teams`;
  const first = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId }),
  });

  let res: { success: boolean };
  if (first.ok) {
    res = (await first.json().catch(() => ({ success: true }))) as { success: boolean };
  } else if (first.status === 404 || first.status === 405) {
    res = await apiJson<{ success: boolean }>('PUT', `/v2/recordings/${recordingId}/teams/${teamId}`);
  } else {
    const text = await first.text().catch(() => '');
    console.error(chalk.red(`Grain API error ${first.status} ${first.statusText} on PUT ${url}`));
    if (text) console.error(chalk.gray(text.slice(0, 1000)));
    process.exit(1);
  }

  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Shared ${recordingId} with team ${teamId}`));
}

async function unshareWithTeam(recordingId: string, teamId: string, options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>('DELETE', `/v2/recordings/${recordingId}/teams/${teamId}`);
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Unshared ${recordingId} from team ${teamId}`));
}

// ============================================================================
// Hook commands
// ============================================================================

async function createHook(
  hookUrl: string,
  options: IncludeOptions & { type: string; transcript?: boolean; speakers?: boolean; json?: boolean }
): Promise<void> {
  const body: Record<string, unknown> = { hook_url: hookUrl, hook_type: options.type };

  if (options.type.startsWith('highlight_')) {
    const include: Record<string, unknown> = {};
    if (options.transcript) include.transcript = true;
    if (options.speakers) include.speakers = true;
    if (Object.keys(include).length) body.include = include;
  } else if (options.type === 'recording_added' || options.type === 'recording_updated') {
    const include = buildInclude(options);
    if (include) body.include = include;
  }

  const hook = await apiJson<GrainHook>('POST', '/v2/hooks/create', body);

  if (options.json) {
    output(hook, true);
    return;
  }
  console.log(chalk.green('Hook created. Grain probed the URL and got a 2xx.'));
  printHook(hook);
}

async function listHooks(options: { type?: string; state?: string; json?: boolean }): Promise<void> {
  const filter: Record<string, unknown> = {};
  if (options.type) filter.hook_type = options.type;
  if (options.state) filter.state = options.state;

  const res = await apiJson<{ hooks: GrainHook[] }>(
    'POST',
    '/v2/hooks',
    Object.keys(filter).length ? { filter } : {}
  );
  const hooks = res.hooks || [];

  if (options.json) {
    output(hooks, true);
    return;
  }
  if (!hooks.length) {
    console.log(chalk.yellow('\nNo hooks registered.'));
    return;
  }
  console.log(chalk.bold(`\nHooks (${hooks.length}):`));
  hooks.forEach(printHook);
}

async function deleteHook(hookId: string, options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ success: boolean }>('DELETE', `/v2/hooks/${hookId}`);
  if (options.json) {
    output(res, true);
    return;
  }
  console.log(chalk.green(`Deleted hook ${hookId}`));
}

// ============================================================================
// Directory commands (users / teams / meeting types)
// ============================================================================

async function listUsers(options: { search?: string; json?: boolean }): Promise<void> {
  const res = await apiJson<{ users: GrainUser[] }>('POST', '/v2/users', {});
  let users = res.users || [];

  if (options.search) {
    const needle = options.search.toLowerCase();
    users = users.filter(u => u.name?.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle));
  }

  if (options.json) {
    output(users, true);
    return;
  }
  console.log(chalk.bold(`\nUsers (${users.length}):`));
  users.forEach(u => console.log(`  ${chalk.cyan(u.name)}  ${u.email}  ${chalk.gray(u.id)}`));
}

async function listTeams(options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ teams: GrainTeam[] }>('POST', '/v2/teams', {});
  const teams = res.teams || [];
  if (options.json) {
    output(teams, true);
    return;
  }
  console.log(chalk.bold(`\nTeams (${teams.length}):`));
  teams.forEach(t => console.log(`  ${chalk.cyan(t.name)}  ${chalk.gray(t.id)}`));
}

async function listMeetingTypes(options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ meeting_types: GrainMeetingType[] }>('POST', '/v2/meeting_types', {});
  const types = res.meeting_types || [];
  if (options.json) {
    output(types, true);
    return;
  }
  console.log(chalk.bold(`\nMeeting types (${types.length}):`));
  types.forEach(t => console.log(`  ${chalk.cyan(t.name)}  ${t.scope || ''}  ${chalk.gray(t.id)}`));
}

/** No whoami endpoint exists — probe the directory to prove the token works. */
async function checkAuth(options: { json?: boolean }): Promise<void> {
  const res = await apiJson<{ users: GrainUser[] }>('POST', '/v2/users', {});
  const count = res.users?.length ?? 0;
  if (options.json) {
    output({ ok: true, apiVersion: API_VERSION, baseUrl: BASE_URL, visibleUsers: count }, true);
    return;
  }
  console.log(chalk.green('Token works.'));
  console.log(`  base url:      ${BASE_URL}`);
  console.log(`  api version:   ${API_VERSION}`);
  console.log(`  visible users: ${count}`);
  console.log(chalk.gray('  (Grain has no whoami endpoint; this probes POST /v2/users.)'));
}

// ============================================================================
// OAuth2 commands
//
// The token endpoint is unauthenticated and unversioned: it takes a JSON body
// (not form-encoded, despite RFC 6749) and no Grain headers.
// ============================================================================

async function oauthTokenRequest(body: Record<string, unknown>, json?: boolean): Promise<void> {
  const res = await fetch(`${BASE_URL}${API_PREFIX}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(chalk.red(`OAuth2 token request failed: ${res.status} ${res.statusText}`));
    if (text) console.error(chalk.gray(text.slice(0, 1000)));
    process.exit(1);
  }

  const token = JSON.parse(text) as {
    token_type: string;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (json) {
    output(token, true);
    return;
  }

  console.log(chalk.green('\nToken issued.'));
  console.log(`  token_type:    ${token.token_type}`);
  console.log(`  access_token:  ${token.access_token}`);
  if (token.refresh_token) console.log(`  refresh_token: ${token.refresh_token}`);
  if (token.expires_in) {
    console.log(`  expires_in:    ${token.expires_in}s (${formatDuration(token.expires_in * 1000)})`);
  } else {
    console.log(chalk.gray('  no expires_in returned — legacy client, token does not expire'));
  }
  console.log(chalk.yellow('\n  Refresh rotates the refresh_token — always store the newest one.'));
}

/**
 * OAuth client credentials come from .env by default; the flags exist for
 * one-off use but keeping the secret in .env keeps it out of shell history.
 */
function resolveClientId(flag?: string): string {
  const clientId = flag || process.env.GRAIN_OAUTH_CLIENT_ID;
  if (!clientId) {
    console.error(chalk.red('Error: no OAuth2 client id'));
    console.error(chalk.yellow('Set GRAIN_OAUTH_CLIENT_ID in plugins/ks/scripts/.env, or pass --client-id'));
    process.exit(1);
  }
  return clientId;
}

function resolveClientSecret(flag?: string): string | undefined {
  return flag || process.env.GRAIN_OAUTH_CLIENT_SECRET;
}

async function oauthAuthorizeUrl(options: {
  clientId?: string;
  redirectUri: string;
  codeVerifier?: string;
  state?: string;
  json?: boolean;
}): Promise<void> {
  const clientId = resolveClientId(options.clientId);
  const { createHash, randomBytes } = await import('crypto');
  const verifier = options.codeVerifier || randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // `state` is not in Grain's documented param table, but it is standard CSRF
  // protection and harmless to send.
  if (options.state) params.set('state', options.state);

  const url = `https://grain.com${API_PREFIX}/oauth2/authorize?${params.toString()}`;

  if (options.json) {
    output({ url, code_verifier: verifier, code_challenge: challenge }, true);
    return;
  }

  console.log(chalk.bold('\nOpen this URL to authorize:'));
  console.log(`  ${url}`);
  console.log(chalk.bold('\nKeep this to exchange the code:'));
  console.log(`  code_verifier:  ${verifier}`);
  console.log(chalk.gray(`  code_challenge: ${challenge} (S256)`));
  console.log(
    chalk.yellow(
      '\nGrain redirects back to your redirect_uri with ?code=... — then run:\n' +
        `  grain oauth token --code <code> --code-verifier ${verifier}`
    )
  );
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('grain-cli')
  .description(
    'CLI for the Grain public API v2 (recordings, transcripts, hooks, directory).\n' +
      'Requires GRAIN_API_TOKEN in plugins/ks/scripts/.env.'
  )
  .version('1.0.0');

/** Include/filter options shared by list and get. */
function withIncludeOptions(cmd: Command): Command {
  return cmd
    .option(
      '-i, --include <keys...>',
      `Include extra data. Comma- or space-separated. Keys: ${INCLUDE_KEYS.join(', ')}, all ` +
        '(all excludes private_notes, which is Personal-API only)'
    )
    .option('--ai-sections <titles>', 'Include AI template sections, filtered by comma-separated titles')
    .addOption(
      new Option('--ai-format <format>', 'Format for AI template sections').choices(['json', 'markdown', 'text'])
    );
}

// Recording commands
const recordingCmd = program.command('recording').alias('rec').description('Recording operations');

withIncludeOptions(
  recordingCmd
    .command('list')
    .description('List recordings (newest first)')
    .option('--after <date>', 'Lower date bound — YYYY-MM-DD or ISO8601')
    .option('--before <date>', 'Upper date bound — YYYY-MM-DD or ISO8601')
    .addOption(
      new Option('--attendance <kind>', 'Personal API only: recordings you hosted or attended').choices([
        'hosted',
        'attended',
      ])
    )
    .addOption(new Option('--scope <scope>', 'Participant scope').choices(['internal', 'external']))
    .option('-s, --search <text>', 'Match recording titles')
    .option('--team <team-id>', 'Filter by team id (see: grain team list)')
    .option('--meeting-type <id>', 'Filter by meeting type id (see: grain meeting-type list)')
    .option('--cursor <cursor>', 'Resume from a cursor returned by a previous call')
    .option('--all', 'Follow the cursor until every page is fetched')
    .option('--pages <n>', 'Fetch at most N pages', v => parseInt(v, 10))
    .option('-l, --limit <n>', 'Stop after N recordings', v => parseInt(v, 10))
)
  .option('-j, --json', 'Output as JSON')
  .action(listRecordings);

withIncludeOptions(recordingCmd.command('get <recording-id>').description('Get one recording'))
  .option('-j, --json', 'Output as JSON')
  .action(getRecording);

recordingCmd
  .command('window <recording-id>')
  .description('Derive a watch window from the transcript — one request, no media')
  .option('-s, --speakers <names>', 'Comma-separated speaker names (loose match, e.g. "Jon,Jaswanth")')
  .option('-m, --match <regex>', 'Only segments whose text matches this pattern (case-insensitive)')
  .option('-p, --pad <seconds>', 'Padding either side (default 15 — on-screen artefacts precede the words)')
  .option('--after <timecode>', 'Ignore anything before this point')
  .option('--before <timecode>', 'Ignore anything after this point')
  .option('-j, --json', 'Output as JSON')
  .action(suggestWindow);

recordingCmd
  .command('transcript <recording-id>')
  .description('Fetch a transcript')
  .addOption(
    new Option('-f, --format <format>', 'Transcript format').choices([...TRANSCRIPT_FORMATS]).default('json')
  )
  .option('-o, --output <file>', 'Write to a file instead of stdout')
  .option('-j, --json', 'Output raw JSON segments (format=json only)')
  .action(getTranscript);

recordingCmd
  .command('download <recording-id>')
  .description('Download the recording media file')
  .option('-o, --output <file>', 'Target path (default grain-<id>.<ext>)')
  .action(downloadRecording);

withIncludeOptions(
  recordingCmd
    .command('export <recording-id...>')
    .description('Download media + transcript(s) into one folder per recording under the storage root')
    .option('-d, --dir <path>', 'Storage root (default: $GRAIN_STORAGE_DIR, else ~/Documents/Grain)')
    .option('-f, --formats <list>', `Transcript formats, comma-separated: ${TRANSCRIPT_FORMATS.join(', ')}`, 'srt')
    .option('--no-media', 'Skip the media file (transcripts only)')
    .option('--no-metadata', 'Skip writing the recording JSON alongside the media')
    .option('--force', 'Overwrite files that already exist')
)
  .option('-j, --json', 'Output as JSON')
  .action(exportRecordings);

recordingCmd
  .command('frames <recording-id>')
  .description('Extract exact timestamps at full resolution — the escape hatch from crv dedup')
  .option('--at <seconds>', 'Comma-separated source-video timecodes, e.g. 315,730,0:12:35')
  .option('--every <n>', 'Sample every N seconds across the range (ignores dedup entirely)')
  .option('--from <timecode>', 'Range start for --every (default 0)')
  .option('--to <timecode>', 'Range end for --every (default end of recording)')
  .option('--crop <W:H:X:Y>', 'ffmpeg crop filter in SOURCE pixels — isolate the region that matters')
  .option('--crop-in-grid <W:H:X:Y>', 'Same, but measured inside a contact-sheet cell; scaled to source for you')
  .option('--grid-cell-width <px>', 'Grid cell width the --crop-in-grid numbers came from (default 480)')
  .option('--upscale <n>', 'Lanczos upscale factor after cropping, e.g. 3 — what makes small text readable')
  .option(
    '--max-dim <px>',
    'Clamp the long edge (default 2000 — Claude rejects >2000px images once a request holds >20 of them; 0 disables)'
  )
  .option('-d, --dir <path>', 'Storage root (default: $GRAIN_STORAGE_DIR, else ~/Documents/Grain)')
  .option('-o, --out <path>', 'Output directory (default: <recording folder>/frames-manual)')
  .option('--force', 'Overwrite frames that already exist')
  .option('-j, --json', 'Output as JSON')
  .action(extractFrames);

withIncludeOptions(
  recordingCmd
    .command('watch <recording-id...>')
    .description('Export, then analyze with claude-real-video (crv) so the frames + transcript can be read')
    .option('-w, --why <text>', 'What you are looking for — passed to crv as --why')
    .option('-d, --dir <path>', 'Storage root (default: $GRAIN_STORAGE_DIR, else ~/Documents/Grain)')
    .option('-o, --out <path>', 'crv output directory (default: <recording folder>/crv-out)')
    .option('-f, --formats <list>', `Transcript sidecars to write: ${TRANSCRIPT_FORMATS.join(', ')}`, 'srt')
    .option('--max-frames <n>', 'crv --max-frames (default 150)')
    .option('--scene <n>', 'crv --scene sensitivity, lower = more frames (default 0.30)')
    .option('--fps-floor <n>', 'crv --fps-floor, at least one frame every N seconds')
    .option('--from <timecode>', 'Only analyze from this point (90, 1:30, 0:01:30.5) — passed to crv, timestamps stay source-clock')
    .option('--to <timecode>', 'Only analyze up to this point')
    .option('--no-grid', 'Skip crv 3x3 contact sheets (on by default — fewer images to read)')
    .option('--full-res', 'Extract frames at the source width — probes it with ffprobe and passes crv --frame-width')
    .option('--frame-width <px>', 'crv --frame-width in pixels (default 640); wins over --full-res')
    .option('--crv-args <args>', 'Extra flags forwarded verbatim to crv')
    .option('--crv <binary>', 'crv executable (default: $GRAIN_CRV_BIN, else crv)')
    .option('--skip-export', 'Reuse an already-exported folder instead of downloading')
    .option('--force', 'Re-download and overwrite existing export files')
)
  .option('-j, --json', 'Output as JSON (suppresses crv output)')
  .action(watchRecordings);

recordingCmd
  .command('upload <file>')
  .description('Upload a .mov/.mp4/.mp3/.m4a as a new recording')
  .option('-u, --user-id <user-id>', 'Owner of the recording — required with a Workspace token')
  .option('-j, --json', 'Output as JSON')
  .action(uploadRecording);

recordingCmd
  .command('update <recording-id>')
  .description('Rename a recording (title is the only writable field)')
  .requiredOption('-t, --title <title>', 'New title')
  .option('-j, --json', 'Output as JSON')
  .action(updateRecording);

const tagCmd = recordingCmd.command('tag').description('Recording tag operations');

tagCmd
  .command('add <recording-id> <tag>')
  .description('Add a tag (letters/digits with dashes, no spaces)')
  .option('-j, --json', 'Output as JSON')
  .action(addTag);

tagCmd
  .command('remove <recording-id> <tag>')
  .alias('rm')
  .description('Remove a tag')
  .option('-j, --json', 'Output as JSON')
  .action(removeTag);

const shareCmd = recordingCmd.command('share').description('Share a recording (grants access; no permission levels)');

shareCmd
  .command('user <recording-id> <user-id>')
  .description('Share with a user (see: grain user list)')
  .option('-j, --json', 'Output as JSON')
  .action(shareWithUser);

shareCmd
  .command('team <recording-id> <team-id>')
  .description('Share with a team (see: grain team list)')
  .option('-j, --json', 'Output as JSON')
  .action(shareWithTeam);

const unshareCmd = recordingCmd.command('unshare').description('Revoke a share');

unshareCmd
  .command('user <recording-id> <user-id>')
  .description('Unshare from a user')
  .option('-j, --json', 'Output as JSON')
  .action(unshareWithUser);

unshareCmd
  .command('team <recording-id> <team-id>')
  .description('Unshare from a team')
  .option('-j, --json', 'Output as JSON')
  .action(unshareWithTeam);

// Hook commands
const hookCmd = program.command('hook').description('Webhook operations');

withIncludeOptions(
  hookCmd
    .command('create <hook-url>')
    .description('Register a webhook (Grain probes the URL and needs a 2xx)')
    .addOption(new Option('-t, --type <type>', 'Event that fires the hook').choices([...HOOK_TYPES]).makeOptionMandatory())
    .option('--transcript', 'highlight_* hooks: include the clip transcript')
    .option('--speakers', 'highlight_* hooks: include the clip speakers')
)
  .option('-j, --json', 'Output as JSON')
  .action(createHook);

hookCmd
  .command('list')
  .description('List registered webhooks')
  .addOption(new Option('-t, --type <type>', 'Filter by event type').choices([...HOOK_TYPES]))
  .addOption(new Option('--state <state>', 'Filter by state').choices(['enabled', 'disabled']))
  .option('-j, --json', 'Output as JSON')
  .action(listHooks);

hookCmd
  .command('delete <hook-id>')
  .alias('rm')
  .description('Delete a webhook (there is no update — delete and recreate)')
  .option('-j, --json', 'Output as JSON')
  .action(deleteHook);

// Directory commands
const userCmd = program.command('user').description('Workspace user operations (read-only)');

userCmd
  .command('list')
  .description('List workspace users')
  .option('-s, --search <text>', 'Filter by name or email (client-side)')
  .option('-j, --json', 'Output as JSON')
  .action(listUsers);

const teamCmd = program.command('team').description('Team operations (read-only)');

teamCmd
  .command('list')
  .description('List teams')
  .option('-j, --json', 'Output as JSON')
  .action(listTeams);

const meetingTypeCmd = program
  .command('meeting-type')
  .description('Meeting type operations (read-only)');

meetingTypeCmd
  .command('list')
  .description('List meeting types')
  .option('-j, --json', 'Output as JSON')
  .action(listMeetingTypes);

// Auth commands
const authCmd = program.command('auth').description('Token checks');

authCmd
  .command('check')
  .description('Verify GRAIN_API_TOKEN works')
  .option('-j, --json', 'Output as JSON')
  .action(checkAuth);

const oauthCmd = program.command('oauth').description('OAuth2 authorization-code flow (PKCE)');

oauthCmd
  .command('authorize-url')
  .description('Build the authorize URL and a PKCE verifier/challenge pair')
  .option('--client-id <id>', 'OAuth2 client id (default: $GRAIN_OAUTH_CLIENT_ID)')
  .requiredOption('--redirect-uri <uri>', 'Must match the registered redirect URI prefix')
  .option('--code-verifier <verifier>', 'Reuse an existing verifier instead of generating one')
  .option('--state <state>', 'CSRF state value (undocumented by Grain, standard practice)')
  .option('-j, --json', 'Output as JSON')
  .action(oauthAuthorizeUrl);

oauthCmd
  .command('token')
  .description('Exchange an authorization code for tokens')
  .requiredOption('--code <code>', 'Code from the redirect')
  .option('--client-id <id>', 'OAuth2 client id (default: $GRAIN_OAUTH_CLIENT_ID)')
  .option('--client-secret <secret>', 'Server-side clients (default: $GRAIN_OAUTH_CLIENT_SECRET)')
  .option('--code-verifier <verifier>', 'PKCE verifier from authorize-url')
  .option('-j, --json', 'Output as JSON')
  .action(opts => {
    const clientSecret = resolveClientSecret(opts.clientSecret);
    return oauthTokenRequest(
      {
        grant_type: 'authorization_code',
        code: opts.code,
        client_id: resolveClientId(opts.clientId),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
      },
      opts.json
    );
  });

oauthCmd
  .command('refresh')
  .description('Refresh an access token (rotates the refresh token)')
  .option('--refresh-token <token>', 'Refresh token (default: $GRAIN_OAUTH_REFRESH_TOKEN)')
  .option('--client-id <id>', 'OAuth2 client id (default: $GRAIN_OAUTH_CLIENT_ID)')
  .option('--client-secret <secret>', 'Server-side clients (default: $GRAIN_OAUTH_CLIENT_SECRET)')
  .option('-j, --json', 'Output as JSON')
  .action(opts => {
    const refreshToken = opts.refreshToken || process.env.GRAIN_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) {
      console.error(chalk.red('Error: no refresh token'));
      console.error(
        chalk.yellow('Set GRAIN_OAUTH_REFRESH_TOKEN in plugins/ks/scripts/.env, or pass --refresh-token')
      );
      process.exit(1);
    }
    const clientSecret = resolveClientSecret(opts.clientSecret);
    return oauthTokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: resolveClientId(opts.clientId),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      },
      opts.json
    );
  });

program.parse();
