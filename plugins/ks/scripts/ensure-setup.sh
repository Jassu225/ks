#!/bin/bash
# ensure-setup.sh — the ks plugin's SessionStart hook (startup, resume, clear,
# compact). Makes any session — a plain `claude`, the desktop app, an IDE — get
# what only the claude-ks launcher used to give it:
#   1. records this plugin's folder in ~/.config/ks/plugins.json when it is a
#      clone (never a plugin-cache folder; see lib/ks-root.sh), and rewrites
#      ~/.local/bin shims from before v2, which fell back to a versioned folder
#   2. no node_modules: a clone runs npm ci in place; an installed copy installs into
#      ${CLAUDE_PLUGIN_DATA}/deps (kept across updates, reinstalled only when
#      package-lock.json changes) and links scripts/node_modules to them
#   3. adds rules/ks-rules.md as session context, unless the session was started
#      by a KS launcher (scripts/ks-claude), which passes the same file as
#      --append-system-prompt-file and exports KS_RULES_APPENDED=1
#   4. one line when setup is incomplete: run /ks:setup
# Never fails the session: every step is best effort.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPTS="$ROOT/scripts"
cat >/dev/null # the hook's stdin JSON is not needed

if . "$SCRIPTS/lib/ks-root.sh" 2>/dev/null; then
  ks_register_root ks "$ROOT"
  # One grep per session; the rewrite runs once (every shim gets the v2 marker).
  if [ -f "$HOME/.local/bin/ks-root" ] && ! grep -qF "$KSR_SHIM_MARK" "$HOME/.local/bin/ks-root" 2>/dev/null; then
    ksr_upgrade_shims "$HOME/.local/bin" >/dev/null 2>&1
  fi
fi

# 2. dependencies (an installed plugin's folder ships without node_modules).
# A clone read in place (directory marketplace) installs into its own scripts/,
# like `npm ci` there; an installed copy into the data dir, linked in.
case "$ROOT" in "$HOME/.claude/plugins/cache/"*) IN_CACHE=1 ;; *) IN_CACHE=0 ;; esac
if [ ! -d "$SCRIPTS/node_modules/tsx" ] && [ "$IN_CACHE" = 0 ] && command -v npm >/dev/null 2>&1; then
  ( cd "$SCRIPTS" && npm ci --no-audit --no-fund >/dev/null 2>&1 )
fi
if [ ! -d "$SCRIPTS/node_modules/tsx" ] && [ "$IN_CACHE" = 1 ] && [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && command -v npm >/dev/null 2>&1; then
  DEPS="$CLAUDE_PLUGIN_DATA/deps"
  mkdir -p "$DEPS"
  if ! cmp -s "$SCRIPTS/package-lock.json" "$DEPS/package-lock.json" || [ ! -d "$DEPS/node_modules/tsx" ]; then
    cp "$SCRIPTS/package.json" "$SCRIPTS/package-lock.json" "$DEPS/" \
      && ( cd "$DEPS" && npm ci --no-audit --no-fund >"$DEPS/install.log" 2>&1 ) \
      || rm -f "$DEPS/package-lock.json" # retry next session
  fi
  if [ -d "$DEPS/node_modules/tsx" ] && [ ! -e "$SCRIPTS/node_modules" ]; then
    ln -s "$DEPS/node_modules" "$SCRIPTS/node_modules" 2>/dev/null
  fi
fi

# 3 + 4. context for the session
CTX=""
if [ "${KS_RULES_APPENDED:-}" != 1 ] && [ -f "$ROOT/rules/ks-rules.md" ]; then
  CTX="$(cat "$ROOT/rules/ks-rules.md")"
fi
if . "$SCRIPTS/lib/ks-config.sh" 2>/dev/null; then
  if ! ksc_project_root >/dev/null 2>&1 || [ "$(ksc_source LINEAR_API_KEY)" = unset ]; then
    CTX="${CTX:+$CTX

}KS setup is incomplete on this machine (project path or Linear key missing). Tell the user once: run /ks:setup."
  fi
fi
[ -n "$CTX" ] || exit 0
if command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$CTX" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
else
  printf '%s\n' "$CTX"
fi
exit 0
