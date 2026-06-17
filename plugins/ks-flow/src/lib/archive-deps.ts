// lib/archive-deps.ts — the system binaries the GCS archive feature needs.
//
// Compression is done with the system `tar` piped into homebrew `zstd`
// (`tar -cf - … | zstd --ultra -22 …`). `zstd` is frequently absent on a fresh
// machine, so when the user enables archiving we preflight these and prompt
// them to install whatever's missing. Keep this list canonical — the board's
// /api/archive-preflight route mirrors it (separate npm package, can't import).
export interface RequiredBinary {
  name: string;
  installHint: string;
}

export const REQUIRED_BINARIES: RequiredBinary[] = [
  { name: 'zstd', installHint: 'brew install zstd' },
  {
    name: 'tar',
    installHint: 'tar ships with macOS; if missing run: xcode-select --install',
  },
];
