// POST /api/pick-folder — open a native macOS folder chooser and return the
// selected absolute path. Browsers can't expose a real filesystem path from
// their own pickers, but the board server runs on the same machine as the user,
// so we shell out to AppleScript's `choose folder` to get one.
import { execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  try {
    const script = 'POSIX path of (choose folder with prompt "Select the project repository")';
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
    return NextResponse.json({ path: out.replace(/\/+$/, '') }); // strip trailing slash
  } catch (e) {
    const msg = String((e as { stderr?: string })?.stderr ?? '');
    if (/User canceled|-128/i.test(msg)) return NextResponse.json({ cancelled: true });
    return NextResponse.json(
      { error: 'Native folder picker unavailable — type the path instead.' },
      { status: 500 },
    );
  }
}
