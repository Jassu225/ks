#!/bin/bash
# Stop — the session finished its turn and is now idle awaiting you. Records a
# Stop event for the daemon (which repeats the nudge every N min until you
# resume / the session ends) and fires the immediate notification. Skips when
# reminders are disabled in Settings. Purely observational; exit 0 always.
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

# Record the Stop for the daemon (it owns the recurring nudges).
append_event "$HOOK_SID" "Stop" "$HOOK_SID-$(date +%s)" "$HOOK_CWD"

# Fire the immediate notice (throttled per session).
if ! throttled "$HOOK_SID"; then
  notify "$HOOK_SID" "${HOOK_BRANCH:-idle}" "Claude is waiting on you"
fi
exit 0
