#!/bin/bash
# bootstrap.sh — SessionStart hook. Idempotent; runs in every session (the
# plugin is user-scope) but does heavy work only on first run / dependency
# change. Steps:
#   1. resolve PROJECT_COMMON_DIR + write project.conf  (skip rest if unset)
#   2. node_modules diff-install + build into $CLAUDE_PLUGIN_DATA/daemon
#   3. render + (re)load the launchd agent so the daemon runs 24/7
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="${CLAUDE_PLUGIN_OPTION_project_path:-}"
LABEL="com.ksflow.ingester"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 1) project.conf ------------------------------------------------------------
if [ -z "$PROJECT_PATH" ]; then
  exit 0   # not configured for this machine/user — nothing to do
fi
PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"
if [ ! -d "$PROJECT_PATH" ]; then
  echo "[ks-flow] project_path does not exist: $PROJECT_PATH" >&2
  exit 0
fi

raw=$(git -C "$PROJECT_PATH" rev-parse --git-common-dir 2>/dev/null) || {
  echo "[ks-flow] $PROJECT_PATH is not a git repo" >&2; exit 0;
}
case "$raw" in /*) abs="$raw" ;; *) abs="$PROJECT_PATH/$raw" ;; esac
COMMON_DIR=$(cd "$(dirname "$abs")" && printf '%s/%s' "$(pwd -P)" "$(basename "$abs")")
PROJECT_ID=$(printf '%s' "$COMMON_DIR" | shasum -a 256 | cut -c1-16)

# Derive the data dir from the project (load-method independent — see
# src/lib/datadir.mjs, the single source of truth shared with hooks/daemon/board).
DATA_DIR="$(node "$PLUGIN_ROOT/src/lib/datadir.mjs" --project "$PROJECT_PATH")"
[ -n "$DATA_DIR" ] || DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/ks-flow-karmasuite}"

# One-time migration off the old CLAUDE_PLUGIN_DATA `<plugin>-<marketplace>`
# layout: if the derived dir doesn't exist yet, move the richest legacy dir
# (the one holding the daemon build / PocketBase store) into place.
if [ ! -d "$DATA_DIR" ]; then
  for legacy in "${CLAUDE_PLUGIN_DATA:-}" \
                "$HOME/.claude/plugins/data/ks-flow-karmasuite" \
                "$HOME/.claude/plugins/data/ks-flow-inline"; do
    [ -n "$legacy" ] && [ -d "$legacy" ] && [ "$legacy" != "$DATA_DIR" ] || continue
    if [ -e "$legacy/daemon/dist" ] || [ -d "$legacy/pocketbase/pb_data" ]; then
      mkdir -p "$(dirname "$DATA_DIR")"
      mv "$legacy" "$DATA_DIR"
      echo "[ks-flow] migrated data dir: $legacy -> $DATA_DIR" >&2
      break
    fi
  done
fi

DAEMON_DIR="$DATA_DIR/daemon"
mkdir -p "$DATA_DIR"

# worktree paths (realpath'd) as a JSON array
WORKTREES_JSON=$(git -C "$PROJECT_PATH" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{print substr($0,10)}' \
  | while read -r w; do [ -d "$w" ] && (cd "$w" && pwd -P); done \
  | jq -R . | jq -sc .)
[ -n "$WORKTREES_JSON" ] || WORKTREES_JSON="[]"

jq -nc \
  --arg path "$PROJECT_PATH" --arg cd "$COMMON_DIR" --arg id "$PROJECT_ID" \
  --argjson wts "$WORKTREES_JSON" \
  '{projectPath:$path, commonDir:$cd, projectId:$id, worktreePaths:$wts}' \
  >"$DATA_DIR/project.conf"

# 2) dependency diff-install + build ----------------------------------------
# Reinstall only when the bundled manifest differs from the installed copy
# (the documented $CLAUDE_PLUGIN_DATA pattern), or when dist is missing.
NEED_BUILD=0
if [ ! -f "$DAEMON_DIR/dist/daemon.js" ]; then
  NEED_BUILD=1
elif ! diff -q "$PLUGIN_ROOT/src/package.json" "$DAEMON_DIR/package.json" >/dev/null 2>&1; then
  NEED_BUILD=1
elif ! diff -qr "$PLUGIN_ROOT/src/lib" "$DAEMON_DIR/lib" >/dev/null 2>&1 \
     || ! diff -q "$PLUGIN_ROOT/src/daemon.ts" "$DAEMON_DIR/daemon.ts" >/dev/null 2>&1; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  echo "[ks-flow] installing/building daemon into $DAEMON_DIR" >&2
  mkdir -p "$DAEMON_DIR"
  cp -R "$PLUGIN_ROOT/src/." "$DAEMON_DIR/"
  # Use a data-dir-local npm cache to avoid the common ~/.npm root-owned EPERM.
  ( cd "$DAEMON_DIR" && npm install --no-audit --no-fund --cache "$DATA_DIR/.npm" && npm run build ) >&2
fi

# 2b) PocketBase store -------------------------------------------------------
# Resolve the effective provider the SAME way the daemon/board do (see
# src/lib/config.ts): explicit db_provider wins; else firestore iff a cloud
# project is configured; else pocketbase (the zero-config local default).
PB_VERSION=0.39.2
DBP="${CLAUDE_PLUGIN_OPTION_db_provider:-}"
if [ -z "$DBP" ]; then
  if [ "${CLAUDE_PLUGIN_OPTION_firestore_mode:-emulator}" = "cloud" ] \
     && [ -n "${CLAUDE_PLUGIN_OPTION_gcp_project_id:-}" ]; then
    DBP=firestore
  else
    DBP=pocketbase
  fi
fi

if [ "$DBP" = "pocketbase" ]; then
  PB_DIR="$DATA_DIR/pocketbase"
  mkdir -p "$PB_DIR"
  # Schema migrations are always refreshed from the bundled plugin.
  rm -rf "$PB_DIR/pb_migrations"
  cp -R "$PLUGIN_ROOT/pocketbase/pb_migrations" "$PB_DIR/pb_migrations"

  if [ ! -x "$PB_DIR/pocketbase" ]; then
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64 | amd64) ARCH=amd64 ;;
      arm64 | aarch64) ARCH=arm64 ;;
    esac
    ASSET="pocketbase_${PB_VERSION}_${OS}_${ARCH}.zip"
    URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${ASSET}"
    echo "[ks-flow] downloading PocketBase ${PB_VERSION} (${OS}/${ARCH})" >&2
    TMP_ZIP="$(mktemp -t ksflow-pb)"
    if curl -fsSL "$URL" -o "$TMP_ZIP"; then
      unzip -o -q "$TMP_ZIP" pocketbase -d "$PB_DIR"
      chmod +x "$PB_DIR/pocketbase"
    else
      echo "[ks-flow] PocketBase download failed ($URL) — board store unavailable until resolved" >&2
    fi
    rm -f "$TMP_ZIP"
  fi

  # Ensure a superuser exists so the first-run admin installer doesn't block.
  # (Operational reads/writes use public collection rules — no auth needed.)
  if [ -x "$PB_DIR/pocketbase" ]; then
    PB_EMAIL="ks-flow@example.com"
    if grep -q '^POCKETBASE_ADMIN_PASSWORD=' "$DATA_DIR/.env" 2>/dev/null; then
      PB_PASS="$(grep '^POCKETBASE_ADMIN_PASSWORD=' "$DATA_DIR/.env" | head -1 | cut -d= -f2-)"
    else
      # Finite input → no SIGPIPE (a piped `tr </dev/urandom | head` aborts the
      # script under `set -o pipefail`).
      PB_PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
      printf 'POCKETBASE_ADMIN_EMAIL=%s\nPOCKETBASE_ADMIN_PASSWORD=%s\n' \
        "$PB_EMAIL" "$PB_PASS" >>"$DATA_DIR/.env"
    fi
    "$PB_DIR/pocketbase" superuser upsert "$PB_EMAIL" "$PB_PASS" \
      --dir="$PB_DIR/pb_data" --migrationsDir="$PB_DIR/pb_migrations" >/dev/null 2>&1 || true
  fi
fi

# 3) launchd agent -----------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[ks-flow] node not found on PATH; daemon not installed" >&2
  exit 0
fi
NODE_DIR="$(dirname "$NODE_BIN")"
DAEMON_JS="$DAEMON_DIR/dist/daemon.js"

emit_env() {
  local k v
  for k in project_path workflow_user db_provider firestore_mode gcp_project_id \
           firestore_client_email firestore_private_key firestore_credentials \
           pocketbase_port idle_minutes notify_throttle_sec board_port; do
    v="$(eval "printf '%s' \"\${CLAUDE_PLUGIN_OPTION_${k}:-}\"")"
    [ -n "$v" ] || continue
    printf '    <key>CLAUDE_PLUGIN_OPTION_%s</key><string>%s</string>\n' "$k" "$v"
  done
  # Only point firebase-admin at the emulator when firestore is the active
  # provider in emulator mode — pocketbase users never touch Firestore.
  if [ "$DBP" = "firestore" ] && [ "${CLAUDE_PLUGIN_OPTION_firestore_mode:-emulator}" = "emulator" ]; then
    printf '    <key>FIRESTORE_EMULATOR_HOST</key><string>%s</string>\n' \
      "${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
  fi
}

mkdir -p "$HOME/Library/LaunchAgents"
NEW_PLIST="$(mktemp)"
cat >"$NEW_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON_JS</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>CLAUDE_PLUGIN_DATA</key><string>$DATA_DIR</string>
$(emit_env)  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/daemon.err.log</string>
</dict>
</plist>
PLIST

UID_NUM="$(id -u)"
if ! diff -q "$NEW_PLIST" "$PLIST" >/dev/null 2>&1; then
  mv "$NEW_PLIST" "$PLIST"
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  echo "[ks-flow] launchd agent (re)loaded" >&2
else
  rm -f "$NEW_PLIST"
  # ensure it is loaded even if the plist was unchanged
  if ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
    launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  elif [ "$NEED_BUILD" = "1" ]; then
    # Rebuilt the daemon but the plist didn't change — the running process is
    # still on old code, so restart it to load the fresh dist.
    launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    echo "[ks-flow] daemon restarted (new build)" >&2
  fi
fi
exit 0
