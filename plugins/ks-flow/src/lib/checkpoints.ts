// lib/checkpoints.ts — local, per-file ingestion bookkeeping.
//
// Byte offsets / inode / size live ONLY here (in $CLAUDE_PLUGIN_DATA), never
// in the cloud store: this is per-line churn that must not incur DB writes.
// Restart re-reads from the persisted newline-aligned offset (no loss). Also
// caches the stable per-file inProject decision (a file's cwd never changes).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHECKPOINTS_PATH } from './paths.js';

export interface Checkpoint {
  byteOffset: number;
  fileSize: number;
  inode: number;
  sessionId: string;
  inProject?: boolean; // cached membership decision (stable per file)
}

type CheckpointMap = Record<string, Checkpoint>;

export class Checkpoints {
  private map: CheckpointMap = {};
  private dirty = false;

  load(): void {
    try {
      this.map = JSON.parse(readFileSync(CHECKPOINTS_PATH, 'utf8')) as CheckpointMap;
    } catch {
      this.map = {};
    }
  }

  get(path: string): Checkpoint | undefined {
    return this.map[path];
  }

  set(path: string, cp: Checkpoint): void {
    this.map[path] = cp;
    this.dirty = true;
  }

  delete(path: string): void {
    delete this.map[path];
    this.dirty = true;
  }

  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt the file. */
  flush(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(CHECKPOINTS_PATH), { recursive: true });
    const tmp = `${CHECKPOINTS_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.map), 'utf8');
    renameSync(tmp, CHECKPOINTS_PATH);
    this.dirty = false;
  }
}
