// web/lib/localguard.ts — the board answers only this Mac's own pages.
//
// The board has no login, and its routes run commands, kill processes and
// remove worktrees. Three layers keep it to this Mac:
//   1. `next start -H 127.0.0.1` (package.json): other machines can't connect.
//   2. Host check: a page whose domain was re-pointed at 127.0.0.1 (DNS
//      rebinding) arrives with its own Host, e.g. `evil.example:4317`.
//   3. Origin check: another site's page in your browser can still send
//      requests to localhost (CSRF). A browser always sends Origin on those,
//      so writes, and every /api/ call, must come from the board's own origin.
// A request with no Origin and no Sec-Fetch-Site is not from a browser page
// (curl, a CLI on this Mac) and passes: local code already has your access.
// Pure, so proxy.ts (Next 16 proxy, formerly middleware) and the src tests share it.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `localhost:4317` → `localhost`; `[::1]:4317` → `[::1]`. Lower-cased. */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

export interface GuardRequest {
  method: string;
  pathname: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}

/** null to let the request through, else why it is refused. */
export function refuseReason(r: GuardRequest): string | null {
  const host = (r.host ?? '').trim().toLowerCase();
  if (!host || !LOOPBACK.has(hostName(host))) return `host not allowed: ${host || '(none)'}`;

  const write = !SAFE_METHODS.has(r.method.toUpperCase());
  const api = r.pathname === '/api' || r.pathname.startsWith('/api/');
  if (!write && !api) return null; // pages and assets; navigation from a link is fine

  const origin = (r.origin ?? '').trim().toLowerCase();
  if (origin) {
    return origin === `http://${host}` ? null : `cross-origin request from ${origin}`;
  }
  // No Origin: a browser marks its own requests with Sec-Fetch-Site.
  const site = (r.secFetchSite ?? '').trim().toLowerCase();
  if (write && site && site !== 'same-origin' && site !== 'none') return `cross-site request (${site})`;
  return null;
}
