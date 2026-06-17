// /api/reminders-preflight — reminders need `terminal-notifier` to show macOS
// notifications. GET checks it; POST installs it via `brew install`.
//
// GET  → { ok: boolean, missing: Array<{ name, installHint }> }
// POST → { ok: boolean, output: string }   (runs `brew install terminal-notifier`)
//
// Resolve/run through the user's login shell so homebrew (/opt/homebrew/bin,
// absent from the board's own PATH) is found.
import { execFileSync, spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const NAME = 'terminal-notifier';
const HINT = 'brew install terminal-notifier';

// Source the login shell, then run the command — so PATH/brew resolve like a terminal.
const SHELL_PRELUDE =
  '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
  '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; ';

function isInstalled(): boolean {
  try {
    if (execFileSync('/usr/bin/which', [NAME], { encoding: 'utf8' }).trim()) return true;
  } catch {
    // not on the current PATH — try the login shell
  }
  try {
    return execFileSync('/bin/zsh', ['-c', `${SHELL_PRELUDE}command -v ${NAME}`], {
      encoding: 'utf8',
    }).trim().length > 0;
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const ok = isInstalled();
  return NextResponse.json({ ok, missing: ok ? [] : [{ name: NAME, installHint: HINT }] });
}

export async function POST(): Promise<NextResponse> {
  if (isInstalled()) return NextResponse.json({ ok: true, output: 'already installed' });

  const output = await new Promise<string>((resolve) => {
    let buf = '';
    const child = spawn('/bin/zsh', ['-c', `${SHELL_PRELUDE}brew install ${NAME}`], {
      env: process.env,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (buf += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`${buf}\n[ks-flow] ${e.message}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });

  const ok = isInstalled();
  return NextResponse.json({ ok, output: output.trim() || (ok ? 'installed' : 'install failed') });
}
