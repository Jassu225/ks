// /api/store/live — the board's live view of the Firestore store, as
// Server-Sent Events. The browser never talks to Firestore itself: this route
// holds firebase-admin listeners (onSnapshot) and streams each snapshot, so no
// Firebase Auth, browser API key or security rules are needed (the database's
// rules stay deny-all for clients; it is shared with other apps).
//
// Offline mode: the last snapshot per scope is kept at <dataDir>/cache/<scope>.json
// and sent first, so a board opened offline shows the last known state; writes
// still waiting in the outbox (lib/outbox.ts) are laid over every snapshot, so
// a note made offline shows at once.
//
// GET ?scope=board,briefing,activity   (one or more, comma-separated)
//   One request carries every scope a tab needs: a browser keeps at most 6
//   connections per site open, and each stream holds one for good, so one
//   stream per scope starved the board's other requests (Notes stuck loading)
//   as soon as two tabs were open. Every event key is `<scope>.<key>`.
//   event: snap    data: { key, docs, idField? } — the full current result of one query
//   event: delta   data: { key, set, del }    — changed docs / removed ids since the
//                                               last snap or delta (keys with an idField
//                                               and no ordering, while no writes wait)
//   event: ready                              — every query has data (live or cached)
//   event: status  data: { online, pending }  — live listeners up? writes waiting?
//                                               Not sent while connecting: only once
//                                               live, after OFFLINE_AFTER_MS without
//                                               live data, or when writes wait.
// Changes are coalesced per query for EMIT_MS, so a burst of daemon writes (a
// restart re-writes cards one by one) becomes a few small deltas, not one
// full copy of the collection per write.
//   event: fail    data: { key, error }       — a listener stopped (client reconnects)
//   : ping                                    — heartbeat every 25 s
// The queries mirror the PocketBase branch of each hook (lib/useBoard.ts,
// lib/useBriefing.ts, lib/useActivity.ts).
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';
import { outboxEntries, outboxFiles, overlay } from '@/lib/outbox';
import { adminFirestore, serverConfig } from '@/lib/serverdb';
import { readScopeCache, writeScopeCache } from '@/lib/storeCache';

export const dynamic = 'force-dynamic';

/** Briefing: items archived within this many days (lib/useBriefing.ts WINDOW_DAYS). */
const WINDOW_DAYS = 60;
const RUNS = 100;
const EVENTS = 200;
const BACKUP_RUNS = 50;
/** The message board's newest commands (the Commands page). */
const COMMANDS = 200;
const HEARTBEAT_MS = 25_000;
const OUTBOX_POLL_MS = 2_000;
/** Save the cache at most this often while changes arrive (a throttle, not a
 * debounce: a steady stream of changes must not postpone it forever). */
const CACHE_EVERY_MS = 5 * 60_000;
/** Coalesce a query's changes this long before sending them. */
const EMIT_MS = 300;
/** No live data this long after opening → report offline (firebase-admin
 * listeners retry silently while the network is down, they don't fail). */
const OFFLINE_AFTER_MS = 12_000;

type Scope = 'board' | 'briefing' | 'activity';
type Doc = Record<string, unknown>;

interface Source {
  key: string;
  /** A query, or a single doc path (meta/settings). */
  query?: Query<DocumentData>;
  doc?: string;
  /** For the outbox overlay: the collection path, the doc id field, and the
   * query's filter / order / limit re-applied to the overlaid list. */
  coll?: string;
  idField?: string;
  keep?: (d: Doc) => boolean;
  order?: (list: Doc[]) => Doc[];
}

const desc = (field: string, max: number) => (list: Doc[]) =>
  [...list].sort((a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? ''))).slice(0, max);

function sources(fs: Firestore, projectId: string, scope: Scope): Source[] {
  // Flat collections at the database root (see src/lib/db/providers/firestore.ts);
  // `projectId` is not part of any path.
  void projectId;
  const col = (name: string) => fs.collection(name);
  const path = (name: string) => name;
  if (scope === 'board') {
    // meta/project is retired (one board for several devices): each device's
    // facts are in devices/{id}, the shared settings in meta/settings, and the
    // board derives its columns from the cards.
    return [
      { key: 'devices', query: col('devices'), coll: path('devices'), idField: 'deviceId' },
      { key: 'settings', doc: 'meta/settings' },
      { key: 'workUnits', query: col('workUnits'), coll: path('workUnits'), idField: 'unitId' },
      {
        key: 'sessions',
        query: col('sessions').where('inProject', '==', true),
        coll: path('sessions'),
        idField: 'sessionId',
        keep: (d) => d.inProject === true,
      },
      { key: 'reminders', query: col('reminders'), coll: path('reminders'), idField: 'uid' },
    ];
  }
  if (scope === 'briefing') {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const items = path('briefingItems');
    return [
      // Two single-field queries (no composite index), merged by the client.
      {
        key: 'openItems',
        query: col('briefingItems').where('status', '==', 'open'),
        coll: items,
        idField: 'uid',
        keep: (d) => d.status === 'open',
      },
      {
        key: 'recentItems',
        query: col('briefingItems').where('archivedAt', '>=', since),
        coll: items,
        idField: 'uid',
        keep: (d) => typeof d.archivedAt === 'string' && d.archivedAt >= since,
      },
      {
        key: 'runs',
        query: col('briefingRuns').orderBy('startedAt', 'desc').limit(RUNS),
        coll: path('briefingRuns'),
        idField: 'uid',
        order: desc('startedAt', RUNS),
      },
      {
        key: 'dailyLogs',
        query: col('dailyLogs').where('date', '>=', since.slice(0, 10)),
        coll: path('dailyLogs'),
        idField: 'uid',
        keep: (d) => typeof d.date === 'string' && d.date >= since.slice(0, 10),
      },
    ];
  }
  return [
    {
      key: 'masterEvents',
      query: col('masterEvents').orderBy('at', 'desc').limit(EVENTS),
      coll: path('masterEvents'),
      idField: 'uid',
      order: desc('at', EVENTS),
    },
    // Only a change signal: the runs themselves come from /api/backup-runs.
    { key: 'backupRuns', query: col('backupRuns').orderBy('startedAt', 'desc').limit(BACKUP_RUNS) },
    {
      key: 'deviceCommands',
      query: col('deviceCommands').orderBy('createdAt', 'desc').limit(COMMANDS),
      coll: path('deviceCommands'),
      idField: 'uid',
      order: desc('createdAt', COMMANDS),
    },
  ];
}

const SCOPES: Scope[] = ['board', 'briefing', 'activity'];

export async function GET(req: Request): Promise<Response> {
  const scopes = [...new Set((new URL(req.url).searchParams.get('scope') ?? '').split(','))] as Scope[];
  if (scopes.length === 0 || !scopes.every((s) => SCOPES.includes(s))) {
    return new Response('scope must be a comma-separated list of board, briefing, activity', { status: 400 });
  }
  const cfg = serverConfig();
  if (cfg.dbProvider !== 'firestore') {
    return new Response('the store is not Firestore', { status: 409 });
  }
  if (!cfg.projectId) return new Response('no project configured', { status: 409 });

  let fs: Firestore;
  try {
    fs = await adminFirestore(cfg);
  } catch (e) {
    return new Response(`firestore init failed: ${(e as Error).message}`, { status: 500 });
  }

  const enc = new TextEncoder();
  const unsubs: Array<() => void> = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  /** Writes the cache now if a save is pending (set by start()). */
  let flushCache: (() => void) | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  const flushTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let closed = false;

  const stop = (): void => {
    closed = true;
    timers.forEach((t) => clearInterval(t));
    for (const t of Object.values(flushTimers)) clearTimeout(t);
    if (offlineTimer) clearTimeout(offlineTimer);
    flushCache?.(); // a closing board keeps its last few seconds of changes
    unsubs.forEach((u) => u());
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const raw = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          stop();
        }
      };
      const send = (event: string, data?: unknown): void =>
        raw(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
      const close = (): void => {
        if (closed) return;
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', close);

      const list = scopes.flatMap((sc) =>
        sources(fs, cfg.projectId, sc).map((s) => ({ ...s, key: `${sc}.${s.key}` })),
      );
      /** The cache stays one file per scope, with the scope's own keys. */
      const writeCaches = (): void => {
        for (const sc of scopes) {
          const snaps: Record<string, Doc[]> = {};
          for (const [k, v] of Object.entries(current)) {
            if (k.startsWith(`${sc}.`)) snaps[k.slice(sc.length + 1)] = v;
          }
          writeScopeCache(cfg.dataDir, sc, snaps);
        }
      };
      const current: Record<string, Doc[]> = {};
      /** Changes not sent yet, per key: doc id → doc, or null when removed. */
      const dirty: Record<string, Map<string, Doc | null>> = {};
      /** Keys whose full list the client holds (deltas apply to it). */
      const fullSent = new Set<string>();
      let liveReady = false;
      let readySent = false;
      let lastOutbox = '';
      let lastStatus = '';

      const view = (s: Source, docs: Doc[]): Doc[] => {
        if (!s.coll || !s.idField) return docs;
        const field = s.idField;
        const out = overlay(docs, outboxEntries(cfg.dataDir), s.coll, (d) => String(d[field] ?? ''), s.keep);
        return s.order ? s.order(out) : out;
      };
      /** The whole list (overlaid with queued writes). */
      const emitFull = (s: Source): void => {
        const docs = current[s.key];
        if (!docs) return;
        dirty[s.key]?.clear();
        send('snap', { key: s.key, docs: view(s, docs), idField: s.idField });
        fullSent.add(s.key);
      };
      /** Only what changed, when the client can apply it; else the whole list. */
      const emitChanges = (s: Source): void => {
        const d = dirty[s.key];
        const canDelta =
          s.idField && !s.order && fullSent.has(s.key) && outboxFiles(cfg.dataDir).length === 0;
        if (!canDelta || !d) return emitFull(s);
        if (d.size === 0) return;
        const set: Doc[] = [];
        const del: string[] = [];
        for (const [id, doc] of d) {
          if (doc) set.push(doc);
          else del.push(id);
        }
        d.clear();
        send('delta', { key: s.key, set, del });
      };
      const schedule = (s: Source): void => {
        if (flushTimers[s.key]) return;
        flushTimers[s.key] = setTimeout(() => {
          delete flushTimers[s.key];
          emitChanges(s);
        }, EMIT_MS);
      };
      const status = (force = false): void => {
        const pending = outboxFiles(cfg.dataDir).length;
        const st = JSON.stringify({ online: liveReady, pending });
        if (!force && st === lastStatus) return;
        lastStatus = st;
        send('status', { online: liveReady, pending });
      };
      flushCache = (): void => {
        if (!cacheTimer) return;
        clearTimeout(cacheTimer);
        cacheTimer = undefined;
        writeCaches();
      };
      const saveCache = (): void => {
        if (cacheTimer) return; // a save is already due within CACHE_EVERY_MS
        cacheTimer = setTimeout(() => {
          cacheTimer = undefined;
          writeCaches();
        }, CACHE_EVERY_MS);
      };

      // 1. The last known state, at once (offline or not).
      let anyCached = false;
      for (const sc of scopes) {
        const cached = readScopeCache(cfg.dataDir, sc);
        if (!cached) continue;
        anyCached = true;
        for (const [k, v] of Object.entries(cached.snaps)) current[`${sc}.${k}`] = v as Doc[];
      }
      if (anyCached) {
        list.forEach(emitFull);
        send('ready');
        readySent = true;
      }
      // Connecting is not offline: say nothing yet unless writes are waiting.
      if (outboxFiles(cfg.dataDir).length > 0) status(true);
      offlineTimer = setTimeout(() => {
        if (!liveReady) status(true);
      }, OFFLINE_AFTER_MS);

      // 2. Live listeners replace it as their snapshots arrive.
      const pending = new Set(list.map((s) => s.key));
      const arrived = (key: string): void => {
        if (!pending.delete(key) || pending.size > 0) return;
        liveReady = true;
        if (!readySent) {
          send('ready');
          readySent = true;
        }
        status(true);
      };
      const fail = (key: string) => (e: Error) => {
        console.error(`[ks-flow] live ${key} listener stopped: ${e.message}`);
        liveReady = false;
        send('fail', { key, error: e.message });
        close();
      };
      for (const s of list) {
        if (s.doc) {
          unsubs.push(
            fs.doc(s.doc).onSnapshot((snap) => {
              current[s.key] = snap.exists ? [snap.data() as Doc] : [];
              emitFull(s);
              saveCache();
              arrived(s.key);
            }, fail(s.key)),
          );
        } else if (s.query) {
          let first = true;
          unsubs.push(
            s.query.onSnapshot((snap) => {
              current[s.key] = snap.docs.map((d) => d.data() as Doc);
              saveCache();
              if (first) {
                // The first live result replaces the cached one wholesale.
                first = false;
                emitFull(s);
                arrived(s.key);
                return;
              }
              const d = (dirty[s.key] ??= new Map());
              const field = s.idField;
              for (const c of snap.docChanges()) {
                const doc = c.doc.data() as Doc;
                const id = field ? String(doc[field] ?? c.doc.id) : c.doc.id;
                d.set(id, c.type === 'removed' ? null : doc);
              }
              schedule(s);
            }, fail(s.key)),
          );
        }
      }

      // 3. Queued writes come and go: re-send the overlaid view and the count.
      timers.push(
        setInterval(() => {
          const files = outboxFiles(cfg.dataDir).join(',');
          if (files === lastOutbox) return;
          lastOutbox = files;
          list.forEach(emitFull);
          status();
        }, OUTBOX_POLL_MS),
      );
      timers.push(setInterval(() => raw(': ping\n\n'), HEARTBEAT_MS));
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
