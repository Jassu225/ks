// lib/release-announce.ts — a pushed KS release reaches every device within
// a minute or two, not at its hourly release check.
//
// meta/settings.releases = { <plugin>: <version> } holds the newest pushed
// version of each KS plugin (ks, ks-flow, ks-master, …). Raised only upward,
// in a transaction, by a daemon running from a clone that is on `main`, clean,
// and level with its upstream (pushed): it reads the clone's
// .claude-plugin/marketplace.json once a minute. A clone that isn't pushed
// never announces, so nothing unpublished is ever announced.
//
// Every daemon watches meta/settings (onSnapshot). When it announces a plugin
// newer than the one installed here, the daemon runs its release check at once
// (`ks-setup update --check`, which reads GitHub), and an available release
// starts the update as usual (a new target is not held by the hourly limit).
import { compareVersions } from './ksroot.js';

export type Releases = Record<string, string>;

/** marketplace.json's plugins → { name: version } (entries without both are left out). */
export function marketplaceVersions(json: string): Releases {
  const out: Releases = {};
  try {
    const m = JSON.parse(json) as { plugins?: { name?: unknown; version?: unknown }[] };
    for (const p of m.plugins ?? []) {
      if (typeof p.name === 'string' && p.name && typeof p.version === 'string' && p.version) out[p.name] = p.version;
    }
  } catch {
    /* unreadable: nothing to announce */
  }
  return out;
}

/** The announced map raised by `mine`, only upward; null when nothing goes up. */
export function announcePatch(current: Releases | null | undefined, mine: Releases): Releases | null {
  const next: Releases = { ...(current ?? {}) };
  let raised = false;
  for (const [plugin, v] of Object.entries(mine)) {
    const cur = next[plugin];
    if (!cur || compareVersions(v, cur) > 0) {
      next[plugin] = v;
      raised = true;
    }
  }
  return raised ? next : null;
}

export interface NewerRelease {
  plugin: string;
  installed: string;
  announced: string;
}

/** Announced plugins newer than the installed ones (a plugin not installed here is left out). */
export function newerAnnounced(
  announced: Releases | null | undefined,
  installed: Record<string, string | null>,
): NewerRelease[] {
  const out: NewerRelease[] = [];
  for (const [plugin, v] of Object.entries(announced ?? {})) {
    const have = installed[plugin];
    if (have && compareVersions(v, have) > 0) out.push({ plugin, installed: have, announced: v });
  }
  return out;
}
