#!/bin/bash
# Stop — the session finished its turn and is now idle awaiting you. Records a
# Stop event for the daemon, which owns ALL stop notices: it fires the first
# notice only after a debounce window of true quiet (no main-agent AND no
# teammate/subagent transcript activity), then repeats every N min until you
# resume / the session ends. The hook deliberately does NOT fire an immediate
# notice — a Stop fires at every main-turn boundary (incl. right after the main
# agent spawns background teammates), so an instant notify misfires while the
# session is still active. Skips when reminders are disabled. exit 0 always.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$DIR/_common.sh"

read_payload
init_data_dir "$HOOK_CWD"                 # derive DATA_DIR from the cwd's repo
require_in_project "$HOOK_CWD"            # exits 0 if out-of-project
[ -n "$HOOK_SID" ] || exit 0

# reminders.enabled defaults to true; skip only if explicitly false.
SETTINGS="$DATA_DIR/board-settings.json"
if [ -f "$SETTINGS" ]; then
  enabled=$(jq -r '.reminders.enabled // true' "$SETTINGS" 2>/dev/null || echo true)
  [ "$enabled" = "false" ] && exit 0
fi

# Record the Stop for the daemon (it owns the debounced first notice + the
# recurring nudges; see the header — no immediate notify here on purpose).
append_event "$HOOK_SID" "Stop" "$HOOK_SID-$(date +%s)" "$HOOK_CWD"
exit 0
