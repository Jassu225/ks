#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# KS_PROJECT_ROOT_PATH: env, then ~/.config/ks/ks.env, then the legacy .config
. "$SCRIPT_DIR/lib/ks-config.sh"
PROJECT_ROOT="$(ksc_project_root || true)"
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: KS_PROJECT_ROOT_PATH is not set."
  echo "Set it with: ks-config set ks.KS_PROJECT_ROOT_PATH <path>   (or run /ks:setup)"
  exit 1
fi

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Error: Project root directory does not exist: $PROJECT_ROOT"
  exit 1
fi

cd "$PROJECT_ROOT"

# Ensure we're on main
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Switching to main branch..."
  git checkout main
fi

# Pull latest main
echo "Pulling latest main..."
git pull

# Check that local main is up to date with remote
LOCAL_MAIN=$(git rev-parse main)
REMOTE_MAIN=$(git rev-parse origin/main)
if [ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]; then
  echo "Error: Local main is not up to date with origin/main."
  echo "  Local:  $LOCAL_MAIN"
  echo "  Remote: $REMOTE_MAIN"
  exit 1
fi

# Switch to live and pull
echo "Switching to live branch..."
git checkout live

echo "Pulling latest live..."
git pull

# Generate commit diff (commits in main but not in live)
echo ""
echo "Commits in main but not yet in live:"
echo "======================================"
git log --pretty=format:"[%s](https://github.com/karmasuite/karmasuite/commit/%H) (%cr)" origin/live..origin/main | nl -v1 -w1 -s" - "
echo ""
echo "======================================"
