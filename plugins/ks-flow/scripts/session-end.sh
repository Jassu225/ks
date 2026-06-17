#!/bin/bash
# SessionEnd — the session ended (clear / logout / exit). Records a SessionEnd
# event so the daemon clears any pending stop-nudge for it. No notification.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$DIR/_common.sh"

read_payload
init_data_dir "$HOOK_CWD"                 # derive DATA_DIR from the cwd's repo
require_in_project "$HOOK_CWD"            # exits 0 if out-of-project
[ -n "$HOOK_SID" ] || exit 0

append_event "$HOOK_SID" "SessionEnd" "$HOOK_SID-$(date +%s)" "$HOOK_CWD"
exit 0
