#!/bin/bash
# The ks plugin's bin/ is on PATH for Claude's Bash tool; this runs scripts/spec_metadata.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/spec_metadata.sh" "$@"
