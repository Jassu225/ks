// lib/briefing/keys.ts — how a briefing item is identified and grouped.
//
//   key       slack:<channel>:<ts>                 one item per Slack message
//   groupKey  slack:<channel>:<threadTs ?? ts>     one card per thread
//   uid       the key, safe as a doc id            slack:C123:1730392.45 → slack_C123_1730392_45
//
// Slack permalinks are parsed back to the same parts, so `find --thread` works
// on a message link, a thread link or a bare ts alike.
import type { SlackRef } from '../db/types.js';

/** `key` with every character outside [A-Za-z0-9_-] replaced by `_`. */
export function itemUid(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function keyOf(source: Pick<SlackRef, 'channel' | 'ts'>): string {
  return `slack:${source.channel}:${source.ts}`;
}

export function groupKeyOf(source: Pick<SlackRef, 'channel' | 'ts' | 'threadTs'>): string {
  return `slack:${source.channel}:${source.threadTs ?? source.ts}`;
}

/** A Slack permalink's parts: `…/archives/<channel>/p<ts without the dot>`,
 * a reply's carrying `?thread_ts=<root ts>`. Null when it isn't one. */
export function parseSlackUrl(url: string): { channel: string; ts: string; threadTs: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(u.pathname);
  if (!m) return null;
  const threadTs = u.searchParams.get('thread_ts');
  return { channel: m[1], ts: `${m[2]}.${m[3]}`, threadTs: threadTs && /^\d+\.\d+$/.test(threadTs) ? threadTs : null };
}

/** Does `item` belong to the thread `ref` names (a permalink of any message in
 * it, or a ts)? Matches the item's own links, its ts / thread ts, and — for a
 * permalink — the thread the link points into. */
export function inThread(source: SlackRef, groupKey: string, ref: string): boolean {
  if (ref === source.messageUrl || (source.threadUrl !== null && ref === source.threadUrl)) return true;
  if (ref === source.ts || ref === source.threadTs) return true;
  const p = parseSlackUrl(ref);
  return p !== null && groupKeyOf(p) === groupKey;
}
