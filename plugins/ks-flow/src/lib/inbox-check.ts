// lib/inbox-check.ts — the pure parts of `ks-flow inbox-check` (src/inbox-check.ts):
// reading `tailscale serve status --json` and `plannotator inbox link --list`,
// and deciding which serve mappings are leftovers.
//
// A stopgap until Plannotator reclaims its own Tailscale mappings after a
// reboot: Tailscale keeps background `serve` mappings across restarts, and the
// restarted Inbox refuses to publish over a mapping on its port ("Another
// tailscale serve mapping already uses port …") or to reuse its link door's
// (8443), even when it was its own. A mapping is a leftover only when it is on
// one of the Inbox's ports and points at a loopback address nothing listens on.

/** The ports Plannotator's link door takes (8443, else the next free up to 8450). */
export const DOOR_PORTS = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];

export interface ServeRoute {
  /** The HTTPS port on the tailnet. */
  port: number;
  /** Where it sends traffic (`http://127.0.0.1:57298`), '' when unreadable. */
  target: string;
}

/** Every web route in `tailscale serve status --json` (background and foreground); undefined when unreadable. */
export function serveRoutes(stdout: string): ServeRoute[] | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  const configs = [root, ...Object.values((root.Foreground as Record<string, unknown> | undefined) ?? {})];
  const out: ServeRoute[] = [];
  for (const config of configs) {
    const web = (config as { Web?: unknown } | null)?.Web;
    if (!web || typeof web !== 'object') continue;
    for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
      const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
      if (!Number.isInteger(port)) continue;
      const handlers = (entry as { Handlers?: Record<string, { Proxy?: unknown }> } | null)?.Handlers ?? {};
      const proxy = handlers['/']?.Proxy;
      out.push({ port, target: typeof proxy === 'string' ? proxy : '' });
    }
  }
  return out;
}

/** The loopback port a target points at (`http://127.0.0.1:57298` → 57298), else null. */
export function loopbackPort(target: string): number | null {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/.exec(target.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The leftover mappings: on the Inbox's own port or a door port, pointing at a
 * loopback port nothing listens on. A mapping anywhere else, or one something
 * answers on, is never touched.
 */
export function leftoverRoutes(routes: ServeRoute[], inboxPort: number | null, listening: (port: number) => boolean): ServeRoute[] {
  const ours = new Set<number>([...DOOR_PORTS, ...(inboxPort ? [inboxPort] : [])]);
  return routes.filter((r) => {
    if (!ours.has(r.port)) return false;
    const target = loopbackPort(r.target);
    return target !== null && !listening(target);
  });
}

export interface LinkRow {
  name: string;
  id: string;
  /** "this computer", "online, both ways", "offline …", or what follows. */
  state: string;
  address: string;
  self: boolean;
  /** The rest of the line beyond the address (Plannotator's complaint, if any). */
  note: string;
}

/** `plannotator inbox link --list`: columns separated by two or more spaces. */
export function linkRows(stdout: string): LinkRow[] {
  const rows: LinkRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s{2,}/);
    const idAt = cols.findIndex((c) => /^ibx_[A-Z0-9]+$/.test(c));
    if (idAt < 0) continue;
    const name = cols.slice(0, idAt).join('  ');
    const state = cols[idAt + 1] ?? '';
    const address = cols[idAt + 2] ?? '';
    rows.push({ name, id: cols[idAt], state, address, self: state === 'this computer', note: cols.slice(idAt + 3).join('  ') });
  }
  return rows;
}

/** A linked machine that is fully connected. */
export function linkOnline(row: LinkRow): boolean {
  return row.state === 'online, both ways';
}
