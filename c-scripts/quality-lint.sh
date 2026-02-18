#!/bin/bash

# Hook: Lint changed TypeScript files with ESLint
# Runs on Stop and SubagentStop events

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

echo "=========================================="
echo "[ESLint] Linting $FILE_COUNT files"
echo "=========================================="
echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec eslint --fix 2>&1 || true

exit 0
