// lib/notify.ts — fire a macOS notification from the daemon.
//
// Mirrors _common.sh's `notify` (terminal-notifier), but for the always-on
// node daemon. The launchd PATH is minimal and usually lacks homebrew's
// /opt/homebrew/bin, so resolve the binary once (common paths, then the user
// login shell). No-op if terminal-notifier isn't installed.
import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';

let cached: string | null | undefined;

function resolveTerminalNotifier(): string | null {
  if (cached !== undefined) return cached;
  for (const p of ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier']) {
    try {
      statSync(p);
      cached = p;
      return p;
    } catch {
      // try next
    }
  }
  try {
    const prelude =
      '{ [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"; ' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"; } 2>/dev/null; command -v terminal-notifier';
    cached = execFileSync('/bin/zsh', ['-c', prelude], { encoding: 'utf8' }).trim() || null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Whether terminal-notifier could be resolved (for a startup warning). */
export function terminalNotifierAvailable(): boolean {
  return resolveTerminalNotifier() !== null;
}

/** Fire a notification (backgrounded, never throws). `group` coalesces. */
export function notify(group: string, subtitle: string, message: string): void {
  const bin = resolveTerminalNotifier();
  if (!bin) return;
  try {
    const child = spawn(
      bin,
      ['-title', 'ks-flow', '-subtitle', subtitle, '-message', message, '-group', group],
      { stdio: 'ignore', detached: true },
    );
    child.on('error', () => {
      /* binary vanished — ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
