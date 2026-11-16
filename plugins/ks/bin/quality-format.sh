#!/bin/bash
# The ks plugin's bin/ is on PATH for Claude's Bash tool; this runs scripts/quality-format.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/quality-format.sh" "$@"
