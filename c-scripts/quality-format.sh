#!/bin/bash

# Hook: Format changed TypeScript files with Prettier
# Runs on Stop and SubagentStop events

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

echo "=========================================="
echo "[Prettier] Formatting $FILE_COUNT files"
echo "=========================================="
echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec prettier --write 2>&1 || true

exit 0
