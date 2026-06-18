#!/bin/bash
# _common.sh — shared helpers for the ks-flow notify hooks.
#
# Sourced by notify-*.sh. Provides the project filter (the load-bearing guard
# that keeps a notification firing only for in-project sessions), a per-session
# throttle, an events.jsonl appender, and the terminal-notifier wrapper.

# datadir.mjs is the single source of truth for the data dir (shared with the
# daemon + board). It derives the dir from the cwd's git-common-dir, so a hook
# and the daemon always agree regardless of how the plugin was loaded.
SHIM="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src/lib" && pwd)/datadir.mjs"
# Resolves a cwd → its ks workflow unit (ticket/project) for notification text.
CONTEXT_MJS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/notify-context.mjs"
THROTTLE_SEC="${CLAUDE_PLUGIN_OPTION_notify_throttle_sec:-20}"

# Resolve DATA_DIR (+ dependent paths) from a working directory. Call this once,
# right after read_payload, before any function that touches DATA_DIR.
init_data_dir() {
  local cwd="$1"
  DATA_DIR="$(node "$SHIM" --cwd "$cwd" 2>/dev/null)"
  [ -n "$DATA_DIR" ] || DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/ks-flow-karmasuite}"
  PROJECT_CONF="$DATA_DIR/project.conf"
  EVENTS="$DATA_DIR/events.jsonl"
  CWD_CACHE="$DATA_DIR/cwdcache"
  NOTIFY_STATE="$DATA_DIR/notify-state"
}

# Read the project's common-dir from project.conf (written by bootstrap).
project_common_dir() {
  [ -f "$PROJECT_CONF" ] || return 1
  jq -r '.commonDir // empty' "$PROJECT_CONF" 2>/dev/null
}

# Resolve (and cache) the git-common-dir for a working directory.
resolve_common_dir() {
  local cwd="$1"
  [ -n "$cwd" ] && [ -d "$cwd" ] || return 1
  local key cache
  key=$(printf '%s' "$cwd" | shasum -a 256 | cut -c1-32)
  cache="$CWD_CACHE/$key"
  if [ -f "$cache" ]; then
    cat "$cache"
    return 0
  fi
  local raw abs
  raw=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$raw" in
    /*) abs="$raw" ;;
    *) abs="$cwd/$raw" ;;
  esac
  # realpath (fallback to python if unavailable)
  abs=$(cd "$(dirname "$abs")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$abs")") || abs="$raw"
  mkdir -p "$CWD_CACHE"
  printf '%s' "$abs" >"$cache"
  printf '%s' "$abs"
}

# exit 0 (skip) unless the cwd belongs to the tracked project.
require_in_project() {
  local cwd="$1" want got
  want=$(project_common_dir) || exit 0
  [ -n "$want" ] || exit 0
  got=$(resolve_common_dir "$cwd") || exit 0
  [ "$got" = "$want" ] || exit 0
}

# Suppress if this session was notified within THROTTLE_SEC.
throttled() {
  local sid="$1" now last f
  mkdir -p "$NOTIFY_STATE"
  f="$NOTIFY_STATE/$sid"
  now=$(date +%s)
  if [ -f "$f" ]; then
    last=$(cat "$f" 2>/dev/null)
    if [ -n "$last" ] && [ $((now - last)) -lt "$THROTTLE_SEC" ]; then
      return 0
    fi
  fi
  printf '%s' "$now" >"$f"
  return 1
}

# Append one overlay/event line for the daemon to ingest.
append_event() {
  local sid="$1" kind="$2" id="$3" cwd="$4" ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  mkdir -p "$DATA_DIR"
  jq -nc --arg ts "$ts" --arg sid "$sid" --arg kind "$kind" --arg id "$id" --arg cwd "$cwd" \
    '{ts:$ts, sessionId:$sid, kind:$kind, id:$id, cwd:$cwd}' >>"$EVENTS"
}

# Fire a macOS notification via terminal-notifier (backgrounded — never blocks
# the hook). `-closeLabel OK` relabels the close button; the primary "Show"
# action can't be removed but is harmless (no open/execute/activate). We omit
# `-sender` (it hangs forever for terminals that aren't registered notification
# clients, e.g. Ghostty). To make notices stay until dismissed, set System
# Settings → Notifications → terminal-notifier → Alert style: Alerts.
# notify <group> <subtitle> <message> [title]   (title defaults to the brand)
notify() {
  local sid="$1" subtitle="$2" message="$3" title="${4:-ks-flow}"
  command -v terminal-notifier >/dev/null 2>&1 || return 0
  ( terminal-notifier \
      -title "$title" \
      -subtitle "$subtitle" \
      -message "$message" \
      -group "$sid" \
      -closeLabel "OK" >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1
}

# Set NOTIFY_TITLE + NOTIFY_SUBTITLE from a cwd's ks workflow unit, so a notice
# reads "KAR-1234 / <ticket title>" (ticket) or "<project title> / <branch>"
# (project). Best-effort: falls back to the brand + branch when no unit matches.
build_notify_fields() {
  local cwd="$1" branch="$2" ctx utype ident utitle
  NOTIFY_TITLE="ks-flow"
  NOTIFY_SUBTITLE="${branch:-idle}"
  [ -n "$cwd" ] || return 0
  ctx="$(node "$CONTEXT_MJS" --cwd "$cwd" 2>/dev/null)" || return 0
  [ -n "$ctx" ] || return 0
  IFS=$'\t' read -r utype ident utitle <<<"$ctx"
  if [ "$utype" = "ticket" ]; then
    NOTIFY_TITLE="${ident:-ks-flow}"
    NOTIFY_SUBTITLE="${utitle:-${branch:-idle}}"
  elif [ "$utype" = "project" ]; then
    NOTIFY_TITLE="${utitle:-${ident:-ks-flow}}"
    NOTIFY_SUBTITLE="${branch:-project}"
  fi
}

# Read stdin payload once; export common fields.
read_payload() {
  local input
  input=$(cat)
  HOOK_CWD=$(printf '%s' "$input" | jq -r '.cwd // empty')
  HOOK_SID=$(printf '%s' "$input" | jq -r '.session_id // empty')
  HOOK_TOOL=$(printf '%s' "$input" | jq -r '.tool_name // empty')
  HOOK_BRANCH=$(printf '%s' "$input" | jq -r '.gitBranch // empty')
}
