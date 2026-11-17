# lib/terminal.sh — open a command in a brand-new terminal window (sourced).
#
#   ks_open_terminal <cmd> [args…]   → 0 and the app's name on stdout, else 1
#
# Ghostty (/Applications or ~/Applications), else Terminal.app. Ghostty: a new
# instance (-n) that neither restores nor saves window state (a config with
# window-save-state = always would add blank windows beside it) and quits when
# its window closes. Terminal.app: `do script` with the command quoted.
#
# `open` and `osascript` are blocked in the Bash sandbox: a script using this
# must be in the sandbox's excludedCommands (ks-setup claude-settings).

ks_open_terminal() {
  local app="" a
  for a in /Applications/Ghostty.app "$HOME/Applications/Ghostty.app"; do [ -d "$a" ] && app="$a" && break; done
  if [ -n "$app" ]; then
    open -na "$app" --args --window-save-state=never --quit-after-last-window-closed=true -e "$@" >/dev/null 2>&1 \
      && { echo Ghostty; return 0; }
    return 1
  fi
  local cmd
  cmd="$(printf '%q ' "$@")"
  osascript -e 'tell application "Terminal" to activate' \
    -e "tell application \"Terminal\" to do script \"${cmd//\"/\\\"}\"" >/dev/null 2>&1 \
    && { echo Terminal; return 0; }
  return 1
}

# ks_start_window <dir> <title> <cmd> [args…]: run the command in <dir> in a new
# terminal window. With tmux, inside a new tmux session named after <title>
# (`:` and `.` become `-`, which tmux names can't hold; -2, -3… when taken), so
# claude-ks-restart can replace it in its pane. The session has
# destroy-unattached on: closing the window (its only client) ends it, Claude
# included, like any terminal window; nothing keeps running out of sight (the
# conversation stays in /resume). The pane drops to a login shell when the
# command exits. Prints where it opened; 1 on failure.
ks_start_window() {
  local dir="$1" title="$2"; shift 2
  local sh="${SHELL:-/bin/zsh}" inner tmux sess base n=2 app
  inner="cd $(printf '%q' "$dir") && $(printf '%q ' "$@"); exec $(printf '%q' "$sh") -l"
  tmux="$(command -v tmux || true)"
  if [ -n "$tmux" ]; then
    base="$(tr ':.' '--' <<<"$title")"; sess="$base"
    while "$tmux" has-session -t "=$sess" 2>/dev/null; do sess="$base-$n"; n=$((n + 1)); done
    # A lone ";" argument separates tmux commands: the option is set on the
    # new session in the same call, before anyone could detach.
    app="$(ks_open_terminal "$tmux" new-session -s "$sess" -c "$dir" "$sh" -lc "$inner" \
      ";" set-option -t "$sess" destroy-unattached on)" || return 1
    echo "started $title in a new $app window (tmux session $sess; closing the window ends it)"
  else
    app="$(ks_open_terminal "$sh" -lc "$inner")" || return 1
    echo "started $title in a new $app window"
  fi
}
