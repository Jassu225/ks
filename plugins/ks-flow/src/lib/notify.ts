// lib/notify.ts — fire a macOS notification from the daemon via terminal-notifier.
//
// terminal-notifier (not osascript) is used so the close button can be relabeled
// (`-closeLabel "OK"`). The alert's primary "Show" action can't be removed or
// relabeled (`-actions` neither relabels it nor is worth its cost — it makes
// terminal-notifier wait for the click, leaking a lingering process per notice),
// but clicking "Show" is harmless here (no -open/-execute/-activate). We
// deliberately DON'T pass `-sender`: that masquerade hangs forever for terminals
// that aren't registered notification clients (e.g. Ghostty). Notices appear
// under terminal-notifier's own identity; to make them stay until dismissed, set
// System Settings → Notifications → terminal-notifier → Alert style: Alerts.
//
// The launchd PATH is minimal and usually lacks /opt/homebrew/bin, so resolve
// the binary once (common paths, then the user login shell).
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

/** Fire a notification (backgrounded, never throws). `group` coalesces. `title`
 * is the bold first line (defaults to the brand); pass the ticket id / project
 * title for a context-rich notice. */
export function notify(
  group: string,
  subtitle: string,
  message: string,
  title = 'ks-flow',
): void {
  const bin = resolveTerminalNotifier();
  if (!bin) return;
  try {
    const child = spawn(
      bin,
      [
        '-title', title,
        '-subtitle', subtitle,
        '-message', message,
        '-group', group,
        '-closeLabel', 'OK',
      ],
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
