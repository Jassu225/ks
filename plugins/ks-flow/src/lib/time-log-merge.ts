// Union of two copies of a unit's time log (~/.claude/ks-time/<id>.jsonl).
//
// The log is append-only JSONL, and ks-time sorts events by `ts` when it reads
// them, so order on disk carries no meaning. Nothing deduplicates, though: an
// event present in both copies must appear once or it counts twice. Lines are
// compared verbatim, which is exact here — the cloud copy is a byte snapshot of
// a local file, so an event the two share is the same bytes in both.
//
// Merging is what keeps a log's history safe. Before it, a fresh local log (a
// short session on a new machine, or after a prune) blocked the restore of the
// cloud copy, and the next sweep then uploaded that small file over the full
// one in the bucket.

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Lines of `other` that `base` lacks, in `other`'s order, each once. */
export function missingLines(base: string, other: string): string[] {
  const have = new Set(lines(base));
  const out: string[] = [];
  for (const l of lines(other)) {
    if (have.has(l)) continue;
    have.add(l);
    out.push(l);
  }
  return out;
}

function tsOf(line: string): number {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    return typeof ts === 'number' ? ts : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY; // keep an unparseable line, at the end
  }
}

/** Both copies as one log: every line of `base`, plus what only `other` has,
 * ordered by `ts` (stable, so equal stamps keep their order). */
export function mergeLogs(base: string, other: string): string {
  const all = [...lines(base), ...missingLines(base, other)];
  const sorted = all
    .map((l, i) => ({ l, i, ts: tsOf(l) }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map((e) => e.l);
  return sorted.length ? sorted.join('\n') + '\n' : '';
}
