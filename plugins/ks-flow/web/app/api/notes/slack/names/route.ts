// /api/notes/slack/names — resolve Slack IDs from mentions to names.
//
// POST { ids: string[] } → { names: { U123: "Alice", C123: "general", … } }
//
// Handles user IDs (`U…`, from <@U…>) via users.info and channel IDs (`C…`, from
// <#C…>) via conversations.info. Cache-first: the id→name map is persisted in the
// DB (`slack_names` collection / Firestore `slackNames`, via serverdb). Only cache
// misses hit Slack (needs `users:read` / `channels:read` etc.), and those are
// written back. Note text in the DB is never rewritten — substitution is render-time.
// Names are stored bare (no @/# sigil); the client adds the sigil per mention type.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { getSlackNames, putSlackNames } from '@/lib/serverdb';

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

interface SlackUser {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

async function fetchName(token: string, id: string): Promise<string | null> {
  try {
    if (id.startsWith('C')) {
      const url = new URL('https://slack.com/api/conversations.info');
      url.searchParams.set('channel', id);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const d = (await res.json()) as { ok: boolean; channel?: { name?: string } };
      return d.ok ? d.channel?.name || null : null;
    }
    const url = new URL('https://slack.com/api/users.info');
    url.searchParams.set('user', id);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = (await res.json()) as { ok: boolean; user?: SlackUser };
    if (!d.ok || !d.user) return null;
    const u = d.user;
    return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  loadEnvFile(join(dataDir(), '.env'));
  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? [
        ...new Set(
          body.ids.filter((x): x is string => typeof x === 'string' && /^[UC][A-Z0-9]+$/.test(x)),
        ),
      ]
    : [];
  if (ids.length === 0) return NextResponse.json({ names: {} });

  let cache: Record<string, string> = {};
  try {
    cache = await getSlackNames();
  } catch {
    /* DB unavailable → treat as empty cache */
  }
  const missing = ids.filter((id) => !(id in cache));
  const token = (process.env.SLACK_TOKEN ?? '').trim();

  if (missing.length && token) {
    const resolved = await Promise.all(missing.map((id) => fetchName(token, id)));
    const fresh: Record<string, string> = {};
    missing.forEach((id, i) => {
      if (resolved[i]) fresh[id] = resolved[i] as string;
    });
    if (Object.keys(fresh).length) {
      Object.assign(cache, fresh);
      await putSlackNames(fresh).catch(() => {});
    }
  }

  const names: Record<string, string> = {};
  for (const id of ids) if (cache[id]) names[id] = cache[id];
  return NextResponse.json({ names });
}
