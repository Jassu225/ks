'use client';
// Browser PocketBase client. The board talks to the local PocketBase server
// directly (REST for the initial load, SSE for realtime) — the same role the
// Firestore client SDK plays for the firestore provider. One cached instance
// per page; realtime uses the browser's native EventSource.
import PocketBase from 'pocketbase';
import type { BoardConfig } from './types';

let cached: PocketBase | null = null;

export function getPb(cfg: BoardConfig): PocketBase {
  if (cached) return cached;
  cached = new PocketBase(cfg.pocketbaseUrl);
  cached.autoCancellation(false);
  return cached;
}
