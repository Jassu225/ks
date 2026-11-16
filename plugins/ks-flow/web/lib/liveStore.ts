'use client';
// The browser end of /api/store/live: the Firestore store reaches the board as
// Server-Sent Events from the board's own server (the browser never talks to
// Firestore). A `snap` event carries the full current result of one query, a
// `delta` only the docs that changed since (keyed by the snap's idField), as in
// app/api/store/live/route.ts. Either way the handler gets the whole list.
//
// ONE stream per tab, shared by every scope (board, briefing, activity): a
// browser keeps at most 6 connections per site, and each EventSource holds one
// for as long as it is open. With a stream per scope, two board tabs used all
// six and every other request (Notes, backup status, …) waited forever.
// openLive() registers a scope with the shared hub; scopes registered in the
// same tick open together, and a scope added later reopens the stream with it.
//
// EventSource reconnects by itself after a dropped connection or a `fail`
// event; when the server refused the stream outright (an HTTP error closes it
// for good) the hub reopens it after RETRY_MS.

export type LiveScope = 'board' | 'briefing' | 'activity';

export interface LiveHandlers {
  onSnap: (key: string, docs: unknown[]) => void;
  /** True once every query has data (live or the cached last state); false on a failure. */
  onConnected?: (ok: boolean) => void;
  /** Offline mode: live listeners up, and writes waiting in the outbox. */
  onStatus?: (st: LiveStatus) => void;
}

export interface LiveStatus {
  online: boolean;
  pending: number;
}

type Doc = Record<string, unknown>;

export interface LiveHandle {
  /** Resolve at once while the stream is live (its listeners already push every
   * change); otherwise reopen it and resolve once ready (or after RELOAD_WAIT_MS). */
  reload: () => Promise<void>;
  close: () => void;
}

const RETRY_MS = 10_000;
const RELOAD_WAIT_MS = 10_000;

// ── the shared hub (module state: one per tab) ───────────────────────────────
const handlers = new Map<LiveScope, LiveHandlers>();
/** Per `<scope>.<key>`: the id field and the current docs by id (for deltas). */
const lists = new Map<string, { idField: string; docs: Map<string, Doc> }>();
let es: EventSource | null = null;
let openScopes = '';
let ready = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let pendingOpen = false;
let waiters: Array<() => void> = [];

function settle(): void {
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}

/** `board.workUnits` → handler for board, key `workUnits`. */
function route(fullKey: string): { h: LiveHandlers; key: string } | null {
  const dot = fullKey.indexOf('.');
  const h = handlers.get(fullKey.slice(0, dot) as LiveScope);
  return h ? { h, key: fullKey.slice(dot + 1) } : null;
}

function each(fn: (h: LiveHandlers) => void): void {
  for (const h of handlers.values()) fn(h);
}

function shut(): void {
  if (retry) clearTimeout(retry);
  retry = undefined;
  es?.close();
  es = null;
  openScopes = '';
  ready = false;
}

function open(): void {
  shut();
  const scopes = [...handlers.keys()].sort().join(',');
  if (!scopes) return settle();
  lists.clear();
  openScopes = scopes;
  const src = new EventSource(`/api/store/live?scope=${scopes}`);
  es = src;
  src.addEventListener('snap', (ev) => {
    try {
      const { key, docs, idField } = JSON.parse((ev as MessageEvent<string>).data) as {
        key: string;
        docs: Doc[];
        idField?: string;
      };
      if (idField) lists.set(key, { idField, docs: new Map(docs.map((d) => [String(d[idField] ?? ''), d])) });
      else lists.delete(key);
      const r = route(key);
      r?.h.onSnap(r.key, docs);
    } catch {
      /* malformed event — skip */
    }
  });
  src.addEventListener('delta', (ev) => {
    try {
      const { key, set, del } = JSON.parse((ev as MessageEvent<string>).data) as {
        key: string;
        set: Doc[];
        del: string[];
      };
      const l = lists.get(key);
      if (!l) return; // no full list to apply it to (the server sends one first)
      for (const id of del) l.docs.delete(id);
      for (const d of set) l.docs.set(String(d[l.idField] ?? ''), d);
      const r = route(key);
      r?.h.onSnap(r.key, [...l.docs.values()]);
    } catch {
      /* malformed event — skip */
    }
  });
  src.addEventListener('ready', () => {
    ready = true;
    each((h) => h.onConnected?.(true));
    settle();
  });
  src.addEventListener('status', (ev) => {
    try {
      const st = JSON.parse((ev as MessageEvent<string>).data) as LiveStatus;
      each((h) => h.onStatus?.(st));
    } catch {
      /* malformed event — skip */
    }
  });
  src.addEventListener('fail', () => each((h) => h.onConnected?.(false)));
  src.onerror = () => {
    if (es !== src) return;
    ready = false;
    each((h) => h.onConnected?.(false));
    if (src.readyState === EventSource.CLOSED) {
      es = null;
      settle();
      retry = setTimeout(open, RETRY_MS);
    }
  };
}

/** Open (or reopen with the new set of scopes) once this tick's registrations are in. */
function scheduleOpen(): void {
  if (pendingOpen) return;
  pendingOpen = true;
  queueMicrotask(() => {
    pendingOpen = false;
    const want = [...handlers.keys()].sort().join(',');
    if (want !== openScopes || !es) open();
  });
}

export function openLive(scope: LiveScope, h: LiveHandlers): LiveHandle {
  handlers.set(scope, h);
  scheduleOpen();
  let closed = false;
  return {
    reload: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        if (ready && es && es.readyState === EventSource.OPEN) return resolve();
        const t = setTimeout(resolve, RELOAD_WAIT_MS);
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
        open();
      }),
    close: () => {
      if (closed) return;
      closed = true;
      if (handlers.get(scope) === h) handlers.delete(scope);
      if (handlers.size === 0) {
        shut();
        settle();
      } else scheduleOpen();
    },
  };
}
