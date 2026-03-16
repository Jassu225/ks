#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PLUGIN_ROOT/.config"

# Read KS_PROJECT_ROOT_PATH from .config
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: .config file not found at $CONFIG_FILE"
  echo "Run ./init to configure the project root path."
  exit 1
fi

PROJECT_ROOT=$(grep "^KS_PROJECT_ROOT_PATH=" "$CONFIG_FILE" | cut -d'=' -f2-)
# Fallback to legacy PROJECT_ROOT_PATH if KS_ prefix not found
[ -z "$PROJECT_ROOT" ] && PROJECT_ROOT=$(grep "^PROJECT_ROOT_PATH=" "$CONFIG_FILE" | cut -d'=' -f2-)
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: KS_PROJECT_ROOT_PATH not set in $CONFIG_FILE"
  echo "Run ./init to configure the project root path."
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
