// /api/open-notification-settings — open System Settings to the Notifications
// pane so the user can set the notifier app's style to "Alerts" (notices then
// stay until dismissed instead of auto-dismissing as banners). macOS exposes no
// API to flip that programmatically, so we just deep-link to the right pane.
//
// POST → { ok: boolean }
import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  try {
    const child = spawn(
      'open',
      ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'],
      { stdio: 'ignore', detached: true },
    );
    child.on('error', () => {
      /* not macOS / open missing — ignore */
    });
    child.unref();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
