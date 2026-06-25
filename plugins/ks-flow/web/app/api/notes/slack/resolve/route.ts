// /api/notes/slack/resolve — turn a pasted Slack message permalink into a Slack
// note row, fetching the message text + date via SLACK_TOKEN.
//
// POST { url, dueAt? } → { ok, note } | { error }
//
// Slack has no API to LIST saved messages (retired 2023), but a SINGLE message
// is fetchable by (channel, ts) parsed from its permalink:
//   https://<team>.slack.com/archives/<CHANNEL>/p<TS16>[?thread_ts=<parent>&…]
//   p1700000000123456  →  ts 1700000000.123456  (dot 6 from the end)
// Top-level → conversations.history (latest=oldest=ts, inclusive); a thread reply
// (?thread_ts=) → conversations.replies on the parent, picking the matching ts.
// Needs the matching history scope for the channel type (channels|groups|im|mpim:history)
// — the same read scope the ks slack-cli already uses.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getProjectId, upsertReminder } from '@/lib/serverdb';
import type { ReminderDoc } from '@/lib/types';

export const dynamic = 'force-dynamic';

function dataDir(): string {
  return (
    process.env.KS_FLOW_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(homedir(), '.claude', 'plugins', 'data', 'ks-flow-karmasuite')
  );
}

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

interface ParsedLink {
  channel: string;
  ts: string;
  threadTs?: string;
}

// Parse channel + ts (+ optional thread parent) out of a Slack archive permalink.
function parseSlackLink(raw: string): ParsedLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{6,})/i);
  if (!m) return null;
  const channel = m[1];
  const digits = m[2];
  // ts = all-but-last-6 . last-6  (Slack pads the fractional part to 6 digits).
  const ts = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  const threadTs = u.searchParams.get('thread_ts') || undefined;
  return { channel, ts, threadTs };
}

interface SlackMsg {
  ts?: string;
  text?: string;
  user?: string;
}

async function slackGet(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; error?: string; needed?: string; provided?: string; messages?: SlackMsg[] }> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

function scopeError(d: { error?: string; needed?: string; provided?: string }): string {
  if (d.error === 'missing_scope') {
    return `missing_scope — needs "${d.needed || '<channel>:history'}". Token provides: ${d.provided || '(none)'}. Add the channel history scope and reinstall.`;
  }
  return d.error || 'fetch failed';
}

async function fetchMessage(token: string, link: ParsedLink): Promise<SlackMsg> {
  if (link.threadTs) {
    const d = await slackGet(token, 'conversations.replies', {
      channel: link.channel,
      ts: link.threadTs,
      latest: link.ts,
      oldest: link.ts,
      inclusive: 'true',
      limit: '1',
    });
    if (!d.ok) throw new Error(scopeError(d));
    const hit = (d.messages ?? []).find((m) => m.ts === link.ts) ?? d.messages?.[0];
    if (!hit) throw new Error('message not found (thread)');
    return hit;
  }
  const d = await slackGet(token, 'conversations.history', {
    channel: link.channel,
    latest: link.ts,
    oldest: link.ts,
    inclusive: 'true',
    limit: '1',
  });
  if (!d.ok) throw new Error(scopeError(d));
  const hit = (d.messages ?? []).find((m) => m.ts === link.ts) ?? d.messages?.[0];
  if (!hit) throw new Error('message not found (the token may not be a member of that channel)');
  return hit;
}

const tsToIso = (ts: string | undefined): string | undefined => {
  if (!ts) return undefined;
  const sec = parseFloat(ts);
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : undefined;
};

export async function POST(req: Request): Promise<NextResponse> {
  loadEnvFile(join(dataDir(), '.env'));
  const token = (process.env.SLACK_TOKEN ?? '').trim();
  if (!token) return NextResponse.json({ error: 'SLACK_TOKEN is not set' }, { status: 400 });

  let body: { url?: string; dueAt?: string; workType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const workType: 'personal' | 'professional' =
    body.workType === 'personal' ? 'personal' : 'professional';
  const url = (body.url ?? '').trim();
  const link = parseSlackLink(url);
  if (!link) {
    return NextResponse.json(
      { error: 'not a Slack message link (expected …/archives/<channel>/p<ts>)' },
      { status: 400 },
    );
  }

  let msg: SlackMsg;
  try {
    msg = await fetchMessage(token, link);
  } catch (e) {
    return NextResponse.json({ error: `Slack: ${(e as Error)?.message}` }, { status: 502 });
  }

  const sourceDate = tsToIso(msg.ts) ?? tsToIso(link.ts);
  // Reminder is OPTIONAL and is purely the caller-chosen due date — never the
  // message's own (past) date. Blank → no reminder. The message date is shown on
  // the card via sourceDate; it does not seed the reminder.
  let dueAt: string | undefined;
  if (typeof body.dueAt === 'string' && body.dueAt) {
    const t = Date.parse(body.dueAt);
    if (Number.isFinite(t)) dueAt = new Date(t).toISOString();
  }

  // Deterministic uid so re-pasting the same link updates rather than duplicates.
  const doc: ReminderDoc = {
    uid: `note:slack:${link.channel}:${link.ts}`,
    projectId: getProjectId(),
    kind: 'note',
    section: 'slack',
    workType,
    text: (msg.text ?? '').trim() || '(no text)',
    sourceDate,
    sourceUrl: url,
    dueAt,
    lastFiredAt: null,
    cleared: false,
    createdAt: new Date().toISOString(),
  };
  try {
    await upsertReminder(doc);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? 'write failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, note: doc });
}
