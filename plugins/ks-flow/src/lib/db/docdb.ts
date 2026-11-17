// lib/db/docdb.ts — the in-memory DocDb: the fake store the device tests run
// against (lib/db/devicestore.ts, lib/device-backfill.ts, lib/ownership.ts,
// the card-owner / card-move commands). Same semantics as the Firestore one
// (providers/firestore.ts firestoreDocDb): `set` replaces, `merge` merges one
// level deep, `create` fails on an existing doc, docs are copied in and out.
// `memory.ts` is the daemon's dry-run writer, not this.
import type { StoreOp } from './outbox.js';
import type { DocDb, Unsubscribe, WatchQuery } from './types.js';

type Doc = Record<string, unknown>;

export class MemoryDocDb implements DocDb {
  docs = new Map<string, Doc>();
  /** Every write() call's ops, in order (tests count batches). */
  batches: StoreOp[][] = [];
  private watchers: Array<{ coll: string; fields: string[]; query: WatchQuery; fn: (docs: Array<{ id: string; data: Doc }>) => void }> = [];
  private docWatchers: Array<{ path: string; fn: (data: Doc | null) => void }> = [];

  constructor(seed: Record<string, Doc> = {}) {
    for (const [p, d] of Object.entries(seed)) this.docs.set(p, structuredClone(d));
  }

  async get(path: string): Promise<Doc | null> {
    const d = this.docs.get(path);
    return d ? structuredClone(d) : null;
  }

  async list(coll: string, fields?: string[]): Promise<Array<{ id: string; data: Doc }>> {
    return this.listNow(coll, fields);
  }

  private listNow(coll: string, fields?: string[]): Array<{ id: string; data: Doc }> {
    const out: Array<{ id: string; data: Doc }> = [];
    for (const [path, d] of this.docs) {
      const slash = path.indexOf('/');
      if (path.slice(0, slash) !== coll || path.indexOf('/', slash + 1) !== -1) continue;
      const data = fields ? Object.fromEntries(fields.filter((f) => f in d).map((f) => [f, d[f]])) : d;
      out.push({ id: path.slice(slash + 1), data: structuredClone(data) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async create(path: string, data: Doc): Promise<boolean> {
    if (this.docs.has(path)) return false;
    this.docs.set(path, structuredClone(data));
    this.notify(path);
    return true;
  }

  async write(ops: StoreOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > 500) throw new Error(`a batch holds at most 500 writes (got ${ops.length})`);
    this.batches.push(ops.map((o) => structuredClone(o)));
    for (const o of ops) {
      if (o.op === 'delete') this.docs.delete(o.path);
      else if (o.op === 'merge') this.docs.set(o.path, { ...(this.docs.get(o.path) ?? {}), ...structuredClone(o.data ?? {}) });
      else this.docs.set(o.path, structuredClone(o.data ?? {}));
      this.notify(o.path);
    }
  }

  async transact(path: string, fn: (current: Doc | null) => Doc | null): Promise<Doc | null> {
    const cur = this.docs.has(path) ? structuredClone(this.docs.get(path)!) : null;
    const patch = fn(cur);
    if (!patch) return null;
    const next = { ...(cur ?? {}), ...structuredClone(patch) };
    this.docs.set(path, next);
    this.notify(path);
    return structuredClone(next);
  }

  watch(
    coll: string,
    fields: string[],
    onChange: (docs: Array<{ id: string; data: Doc }>) => void,
    _onError?: (e: Error) => void,
    query: WatchQuery = {},
  ): Unsubscribe {
    const w = { coll, fields, query, fn: (docs: Array<{ id: string; data: Doc }>) => onChange(docs) };
    this.watchers.push(w);
    onChange(this.watchList(w));
    return () => {
      this.watchers = this.watchers.filter((x) => x !== w);
    };
  }

  watchDoc(path: string, onChange: (data: Doc | null) => void): Unsubscribe {
    const w = { path, fn: onChange };
    this.docWatchers.push(w);
    onChange(this.docs.has(path) ? structuredClone(this.docs.get(path)!) : null);
    return () => {
      this.docWatchers = this.docWatchers.filter((x) => x !== w);
    };
  }

  /** A watcher's view: the filter on whole docs, then the named fields. */
  private watchList(w: { coll: string; fields: string[]; query: WatchQuery }): Array<{ id: string; data: Doc }> {
    const { where = [], orderBy, desc, limit } = w.query;
    const match = (d: Doc) =>
      where.every((f) => {
        const v = d[f.field];
        if (f.op === '==') return v === f.value;
        // Firestore leaves docs without the field out of != and >= queries.
        if (v === undefined || v === null) return false;
        if (f.op === '!=') return v !== f.value;
        return String(v) >= String(f.value);
      });
    let list = this.listNow(w.coll).filter((d) => match(d.data));
    if (orderBy) {
      // Like Firestore: docs without the field are left out of an ordered query.
      list = list
        .filter((d) => d.data[orderBy] !== undefined && d.data[orderBy] !== null)
        .sort((a, b) => String(a.data[orderBy]).localeCompare(String(b.data[orderBy])) * (desc ? -1 : 1));
    }
    if (limit) list = list.slice(0, limit);
    return list
      .map((d) => ({ id: d.id, data: w.fields.length ? Object.fromEntries(w.fields.filter((f) => f in d.data).map((f) => [f, d.data[f]])) : d.data }));
  }

  private notify(path: string): void {
    const coll = path.slice(0, path.indexOf('/'));
    for (const w of this.watchers) if (w.coll === coll) w.fn(this.watchList(w));
    for (const w of this.docWatchers)
      if (w.path === path) w.fn(this.docs.has(path) ? structuredClone(this.docs.get(path)!) : null);
  }
}
