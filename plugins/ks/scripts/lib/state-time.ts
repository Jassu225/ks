/**
 * Writes a unit's time spent into its state.yaml: `phases[].engaged_minutes`
 * and a top-level `time_spent` block (see the state schemas).
 *
 * The file is edited in place, not regenerated: comments, key order and quoting
 * stay as they were, so the only diff is the figures themselves.
 */
import { isMap, isSeq, parseDocument, Scalar } from 'yaml';

import type { TimeSummary } from './time-tracking.js';

/** Whole minutes, as state.yaml records them. */
function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/**
 * The state.yaml text with `summary`'s figures in it, or null when they are
 * already there (nothing to write; `updated_at` alone is no change).
 */
export function withTimeSpent(raw: string, summary: TimeSummary, updatedAt: string): string | null {
  const doc = parseDocument(raw);
  let isChanged = false;

  const phases = doc.get('phases');
  if (isSeq(phases)) {
    for (const item of phases.items) {
      if (!isMap(item)) continue;
      const figures = summary.byPhase[String(item.get('number'))];
      if (!figures) continue;
      const engaged = minutes(figures.engagedMs);
      if (item.get('engaged_minutes') !== engaged) {
        item.set('engaged_minutes', engaged);
        isChanged = true;
      }
    }
  }

  const total = minutes(summary.engagedMs);
  const cutoff = minutes(summary.idleMs);
  const was = doc.get('time_spent');
  const isSame = isMap(was) && was.get('engaged_minutes') === total && was.get('idle_cutoff_minutes') === cutoff;
  if (!isSame) {
    const stamp = new Scalar(updatedAt);
    // The rest of state.yaml double-quotes its timestamps.
    stamp.type = Scalar.QUOTE_DOUBLE;
    doc.set('time_spent', doc.createNode({ engaged_minutes: total, idle_cutoff_minutes: cutoff, updated_at: stamp }));
    isChanged = true;
  } else if (isChanged && isMap(was)) {
    const stamp = new Scalar(updatedAt);
    stamp.type = Scalar.QUOTE_DOUBLE;
    was.set('updated_at', stamp);
  }

  return isChanged ? doc.toString({ lineWidth: 0 }) : null;
}
