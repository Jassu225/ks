// lib/jsonl.ts — byte-range reads + per-line parse guard.
//
// Offset discipline (restart-safe, no in-memory residual): the persisted
// byteOffset is always newline-aligned. Each pass reads [byteOffset, size),
// processes only complete (newline-terminated) lines, and advances the offset
// to just past the last "\n". Any partial trailing line is simply re-read on
// the next pass once more bytes arrive — so a crash never loses or
// double-counts a line.
import { openSync, readSync, closeSync } from 'node:fs';

/** Read bytes [start, end) of a file as a utf8 string. */
export function readRange(path: string, start: number, end: number): string {
  const len = end - start;
  if (len <= 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString('utf8', 0, read);
  } finally {
    closeSync(fd);
  }
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export interface ParseResult {
  /** Parsed complete lines; malformed/partial lines dropped. */
  lines: unknown[];
  /** Bytes consumed (newline-aligned), to add to the start offset. 0 if none. */
  consumedBytes: number;
}

/**
 * Parse all complete (newline-terminated) lines in `data`. A malformed line is
 * skipped (per-line try/catch) — never throws. Returns the newline-aligned byte
 * count so the caller advances its persisted offset past the last "\n" only.
 */
export function parseComplete(data: string): ParseResult {
  const nl = data.lastIndexOf('\n');
  if (nl < 0) return { lines: [], consumedBytes: 0 };
  const complete = data.slice(0, nl);
  const lines: unknown[] = [];
  for (const line of complete.split('\n')) {
    if (line.trim() === '') continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed/partial line
    }
  }
  return { lines, consumedBytes: byteLength(complete) + 1 };
}
