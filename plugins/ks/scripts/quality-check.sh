#!/bin/bash

# Quality check hook for Stop and SubagentStop events
# Runs formatting (Prettier), linting (ESLint), and type checking (tsc)
# Based on KarmaSuite CLAUDE.md conventions

# Exit early if not in a git repository
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# Get staged TypeScript files
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get unstaged modified TypeScript files
UNSTAGED_FILES=$(git diff --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get untracked TypeScript files
UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get files changed on this branch vs main (catches already-committed files)
DEFAULT_BRANCH="main"
BRANCH_FILES=$(git diff --name-only "$DEFAULT_BRANCH"...HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Combine, deduplicate, and filter to only existing files
ALL_FILES=""
for file in $STAGED_FILES $UNSTAGED_FILES $UNTRACKED_FILES $BRANCH_FILES; do
  if [ -f "$file" ]; then
    ALL_FILES="$ALL_FILES$file"$'\n'
  fi
done
ALL_FILES=$(echo "$ALL_FILES" | sort -u | sed '/^$/d')

# Exit early if no files to process
if [ -z "$ALL_FILES" ]; then
  exit 0
fi

# Count files to ensure we have something to process
FILE_COUNT=$(echo "$ALL_FILES" | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  exit 0
fi

echo "=========================================="
echo "Running quality checks on modified files:"
echo "$ALL_FILES"
echo "=========================================="

# Step 1: Format with Prettier (as per CLAUDE.md)
echo ""
echo "[1/3] Formatting with Prettier..."
echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec prettier --write 2>&1 || true

# Step 2: Lint with ESLint (as per CLAUDE.md)
echo ""
echo "[2/3] Running ESLint..."
echo "$ALL_FILES" | tr '\n' '\0' | xargs -0 pnpm exec eslint --fix 2>&1 || true

# Step 3: Type check only changed files (using www app's tsconfig)
echo ""
echo "[3/3] Running TypeScript type check..."

# Create temporary tsconfig in www directory that extends its config with only changed files
PROJECT_ROOT=$(git rev-parse --show-toplevel)
TEMP_TSCONFIG="$PROJECT_ROOT/apps/www/.tsconfig.quality-check.json"

# Convert paths to be relative to www directory
FILES_RELATIVE=$(echo "$ALL_FILES" | sed 's|^|../../|')
FILES_JSON=$(echo "$FILES_RELATIVE" | jq -R -s -c 'split("\n") | map(select(length > 0))')

cat > "$TEMP_TSCONFIG" << EOF
{
  "extends": "./tsconfig.json",
  "include": $FILES_JSON
}
EOF

pnpm tsc --noEmit --project "$TEMP_TSCONFIG" 2>&1 || true
rm -f "$TEMP_TSCONFIG"

echo ""
echo "=========================================="
echo "Quality checks complete"
echo "=========================================="

exit 0
