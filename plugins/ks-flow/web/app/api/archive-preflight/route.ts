// /api/archive-preflight — check that the system binaries the GCS archive needs
// are installed, so the Settings page can prompt the user to install whatever's
// missing when they enable archiving.
//
// GET → { ok: boolean, missing: Array<{ name, installHint }> }
//
// Mirrors src/lib/archive-deps.ts (separate npm package — can't import). Resolve
// through the user's login shell so homebrew's /opt/homebrew/bin (absent from
// the board's own minimal PATH) is seen.
import { execFileSync } from 'node:child_process';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface RequiredBinary {
  name: string;
  installHint: string;
}

const REQUIRED_BINARIES: RequiredBinary[] = [
  { name: 'zstd', installHint: 'brew install zstd' },
  { name: 'tar', installHint: 'tar ships with macOS; if missing run: xcode-select --install' },
];

function isInstalled(name: string): boolean {
  try {
    if (execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim()) return true;
  } catch {
    // not on the current PATH — fall through to the shell prelude
  }
  try {
    const prelude =
      '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; command -v ' +
      name;
    return execFileSync('/bin/zsh', ['-c', prelude], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const missing = REQUIRED_BINARIES.filter((b) => !isInstalled(b.name));
  return NextResponse.json({ ok: missing.length === 0, missing });
}
