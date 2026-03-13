#!/bin/bash

# Hook: Format changed TypeScript files with Prettier
# Runs on Stop and SubagentStop events
#
# Strategy:
#   1. Run prettier --write to auto-format files
#   2. Run prettier --check to verify all files are formatted
#   3. Exit non-zero if any files couldn't be formatted (e.g., parse errors)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

echo "=========================================="
echo "[Prettier] Formatting $FILE_COUNT files"
echo "=========================================="

# Step 1: Auto-format files
echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec prettier --write 2>&1 || true

# Step 2: Verify formatting — catches files that prettier couldn't handle
CHECK_OUTPUT=$(echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec prettier --check 2>&1)
CHECK_EXIT=$?

if [ $CHECK_EXIT -ne 0 ]; then
  echo "" >&2
  echo "==========================================" >&2
  echo "[Prettier] Formatting issues remain:" >&2
  echo "==========================================" >&2
  echo "$CHECK_OUTPUT" >&2
  exit 2
fi

exit 0
