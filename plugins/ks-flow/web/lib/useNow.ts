'use client';
import { useEffect, useState } from 'react';

/** Current time, refreshed on an interval so recency-based UI self-updates.
 * Use ONE instance high in the tree (the board) and pass `now` down, rather
 * than a timer per card. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
