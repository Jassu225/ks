#!/bin/bash

# Hook: Lint changed TypeScript files with ESLint
# Runs on Stop and SubagentStop events
#
# Strategy:
#   1. Run eslint --fix to auto-fix what it can (e.g., unused imports)
#   2. Re-run eslint without --fix to check for remaining issues
#   3. Exit non-zero if unfixable issues remain (e.g., unused variables)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

echo "=========================================="
echo "[ESLint] Linting $FILE_COUNT files"
echo "=========================================="

# Step 1: Auto-fix what we can (swallow exit code — we check properly in step 2)
echo "$ALL_FILES" | tr '\n' '\0' | KS_SORT_IMPORTS=true xargs -0 pnpm exec eslint --fix 2>&1 || true

# Step 2: Re-check for remaining issues that --fix couldn't resolve
LINT_OUTPUT=$(echo "$ALL_FILES" | tr '\n' '\0' | KS_SORT_IMPORTS=true xargs -0 pnpm exec eslint 2>&1)
LINT_EXIT=$?

if [ $LINT_EXIT -ne 0 ]; then
  echo "" >&2
  echo "==========================================" >&2
  echo "[ESLint] Unfixable lint issues found:" >&2
  echo "==========================================" >&2
  echo "$LINT_OUTPUT" >&2
  exit 2
fi

exit 0
