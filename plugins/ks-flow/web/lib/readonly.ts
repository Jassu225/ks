// lib/readonly.ts — SERVER-only: this board is read-only while its device is
// behind the store's data format (src/lib/versioning.ts; README "Versioning").
// The daemon publishes <dataDir>/version-status.json; every API route that
// writes to the store calls `readOnlyResponse()` first and answers 409, and
// lib/outbox.ts writeOrQueue refuses as a backstop. Local-only routes (open a
// file, kill a process, pick a folder) are not gated.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { boardDataDir } from './boardConfig';
import type { VersionStatus } from './types';

export const VERSION_STATUS_FILE = 'version-status.json';

export function readVersionStatus(dataDir: string = boardDataDir()): VersionStatus | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, VERSION_STATUS_FILE), 'utf8')) as VersionStatus;
  } catch {
    return null;
  }
}

/** Why this board may not write the store now, or null. */
export function readOnlyReason(dataDir: string = boardDataDir()): string | null {
  const s = readVersionStatus(dataDir);
  if (!s?.readOnly) return null;
  return `This board is read-only: ks-flow on this device is behind on the data format (schema ${s.schemaVersion} < ${s.storeSchemaVersion}). Nothing is written until it updates (ks-flow update).`;
}

/** A 409 for a store-writing route while read-only, else null (go on). */
export function readOnlyResponse(): NextResponse | null {
  const why = readOnlyReason();
  return why ? NextResponse.json({ error: why, readOnly: true }, { status: 409 }) : null;
}

export class ReadOnlyError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyError';
  }
}
