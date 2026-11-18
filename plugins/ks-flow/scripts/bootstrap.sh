#!/bin/bash
# bootstrap.sh — SessionStart hook. Idempotent; runs in every session (the
# plugin is user-scope) but does heavy work only on first run / dependency
# change. Steps:
#   1. resolve PROJECT_COMMON_DIR + write project.conf  (skip rest if unset)
#   2. node_modules diff-install + build into $CLAUDE_PLUGIN_DATA/daemon
#   3. render + (re)load the launchd agent so the daemon runs 24/7
# Run as the SessionStart hook (KS_FLOW_HOOK=1, hooks.json), it also prints one
# line when this device is behind the store's ks-flow version (versioning:
# <dataDir>/version-status.json, written by the daemon). KS_FLOW_NO_RESTART=1
# (`ks-flow update`, which restarts it itself) skips the daemon restart.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="${CLAUDE_PLUGIN_OPTION_project_path:-}"
LABEL="com.ksflow.ingester"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 0) tools + registry ----------------------------------------------------------
for t in node jq git; do
  command -v "$t" >/dev/null 2>&1 || { echo "[ks-flow] $t not found on PATH — ks-flow is not set up (brew install $t, then /ks:setup)" >&2; exit 0; }
done
# Record this plugin's folder in the KS registry, for a clone only (as the ks
# plugin's ks_register_root): an installed copy lives in a versioned cache folder
# that an update leaves behind, so it is never recorded — ks-root and
# lib/ksroot.ts derive it from Claude Code's installed_plugins.json each time.
# `mode: marketplace` entries (written before that) are dropped. Best effort.
KS_REG="${KS_CONFIG_DIR:-$HOME/.config/ks}/plugins.json"
KS_REG_ROOT="$PLUGIN_ROOT"
case "$PLUGIN_ROOT" in
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/"*|"$HOME/.claude/plugins/cache/"*) KS_REG_ROOT="" ;;
esac
if { [ -n "$KS_REG_ROOT" ] || jq -e 'any(.[]?; .mode? == "marketplace")' "$KS_REG" >/dev/null 2>&1; } \
   && mkdir -p "$(dirname "$KS_REG")" 2>/dev/null; then
  { [ -s "$KS_REG" ] && cat "$KS_REG" || echo '{}'; } 2>/dev/null \
    | jq --arg r "$KS_REG_ROOT" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        with_entries(select(.value.mode? != "marketplace"))
        | if $r == "" then . else .["ks-flow"] = {root: $r, mode: "local", seenAt: $t} end' \
        >"$KS_REG.tmp.$$" 2>/dev/null \
    && mv "$KS_REG.tmp.$$" "$KS_REG" 2>/dev/null || rm -f "$KS_REG.tmp.$$" 2>/dev/null
fi

# A path stored as ~/…, $HOME/… or ${HOME}/… (the same on every machine): the
# home folder put in (as lib/ks-config.sh ksc_expand_home does).
expand_home() {
  case "$1" in
    '~' | '$HOME' | '${HOME}') printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    '$HOME/'*) printf '%s/%s' "$HOME" "${1#\$HOME/}" ;;
    '${HOME}/'*) printf '%s/%s' "$HOME" "${1#\$\{HOME\}/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 1) project.conf ------------------------------------------------------------
# project_path (userConfig) → KS_PROJECT_ROOT_PATH (env, ~/.config/ks/ks.env) →
# the one project already set up here (its project.conf). Without a fallback a
# session with no userConfig quietly never rebuilt after a plugin update.
if [ -z "$PROJECT_PATH" ]; then
  PROJECT_PATH="${KS_PROJECT_ROOT_PATH:-}"
  [ -n "$PROJECT_PATH" ] || PROJECT_PATH="$(sed -n 's/^[[:space:]]*KS_PROJECT_ROOT_PATH[[:space:]]*=[[:space:]]*["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}[[:space:]]*$/\1/p' "${KS_CONFIG_DIR:-$HOME/.config/ks}/ks.env" 2>/dev/null | tail -1)"
  PROJECT_PATH="$(expand_home "$PROJECT_PATH")"
  if [ -z "$PROJECT_PATH" ]; then
    confs=("$HOME"/.claude/plugins/data/ks-flow/*/project.conf)
    [ "${#confs[@]}" = 1 ] && [ -f "${confs[0]}" ] && PROJECT_PATH="$(jq -r '.projectPath // empty' "${confs[0]}" 2>/dev/null)"
  fi
fi
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
  # Only the named old folders: ${CLAUDE_PLUGIN_DATA} is Claude's own data dir
  # for an installed plugin and must never be moved away.
  for legacy in "$HOME/.claude/plugins/data/ks-flow-karmasuite" \
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

# Versioning: one line for the session when this device is behind (or its last
# update failed), as a systemMessage. Printed on exit, whatever step ends the run.
version_line() {
  [ "${KS_FLOW_HOOK:-}" = 1 ] || return 0
  local f="$DATA_DIR/version-status.json" msg
  [ -f "$f" ] || return 0
  msg="$(jq -r '
    def failed: ((.update.state // "") as $s | $s == "failed" or $s == "refused");
    # The daemon'"'"'s hourly release check (`ks-setup update --check`): what is newer.
    def newrel: [.release.plugins[]? | select(.latest != null and .installed != .latest)];
    if (.versionBehind or .schemaBehind) then
      "ks-flow on this device is "
      + (if .versionBehind then "behind (\(.version) → \(.storeVersion))"
         else "behind on the data format (schema \(.schemaVersion) → \(.storeSchemaVersion))" end)
      + (if .schemaBehind then "; its board is read-only" else "" end)
      + (if .dev then ": run `ks-flow update` (dev build: \(.devReason // "not a release"))"
         elif failed then ": run `ks-flow update` (\(.update.reason // "see update.log"))"
         else ": it is updating itself (ks-flow update)" end)
    elif ((.release.state // "") == "available") and (newrel | length > 0) then
      "a new KS release for this device (" + ([newrel[] | "\(.plugin) \(.latest)"] | join(", ")) + ")"
      + (if failed then ": run `ks-setup update` (\(.update.reason // "see update.log"))"
         else ": it is updating itself (ks-setup update)" end)
    elif failed then "ks-flow on this device could not update: run `ks-flow update` (\(.update.reason // "see update.log"))"
    else empty end' "$f" 2>/dev/null)" || return 0
  [ -n "$msg" ] && jq -nc --arg m "$msg" '{systemMessage: $m}'
  return 0
}
trap version_line EXIT

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
else
  # Compare lib/ AND every top-level entrypoint. Naming daemon.ts alone missed a
  # changed, added, or deleted sibling (transcript-backup.ts, transcript-restore.ts
  # …), so an edit to one of those shipped nothing. `diff -q` on the directory
  # listing catches additions and deletions too; excluding dist/ and node_modules
  # keeps it to source.
  if ! diff -qr "$PLUGIN_ROOT/src/lib" "$DAEMON_DIR/lib" >/dev/null 2>&1; then
    NEED_BUILD=1
  else
    for f in "$PLUGIN_ROOT"/src/*.ts; do
      [ -e "$f" ] || continue
      if ! diff -q "$f" "$DAEMON_DIR/$(basename "$f")" >/dev/null 2>&1; then
        NEED_BUILD=1
        break
      fi
    done
    # …and a source deleted upstream must also force a rebuild, so the prune runs.
    if [ "$NEED_BUILD" = "0" ]; then
      for f in "$DAEMON_DIR"/*.ts; do
        [ -e "$f" ] || continue
        [ -e "$PLUGIN_ROOT/src/$(basename "$f")" ] || { NEED_BUILD=1; break; }
      done
    fi
  fi
fi

# The release the daemon reports (ks-flow's plugin.json version, not its
# package.json) and the plugin folder it came from: <daemon>/build.json. A new
# version or folder alone needs no rebuild, only the file and a restart.
PLUGIN_VERSION="$(jq -r '.version // empty' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null || true)"
BUILD_STALE=0
if [ "$(jq -r '"\(.version // "")|\(.pluginRoot // "")"' "$DAEMON_DIR/build.json" 2>/dev/null || true)" != "$PLUGIN_VERSION|$PLUGIN_ROOT" ]; then
  BUILD_STALE=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  echo "[ks-flow] installing/building daemon into $DAEMON_DIR" >&2
  mkdir -p "$DAEMON_DIR"
  # Prune stale sources first: `cp -R` is purely ADDITIVE, so an entrypoint
  # deleted upstream lingers here and breaks the build against the module it
  # imported (exactly what archive.ts / backfill-archive.ts did after the
  # uploader was consolidated). node_modules is deliberately kept — it is the
  # expensive part; dist is rebuilt below anyway.
  find "$DAEMON_DIR" -maxdepth 1 -name '*.ts' -delete 2>/dev/null || true
  rm -rf "$DAEMON_DIR/lib" "$DAEMON_DIR/dist"
  # Sources only: a clone's own node_modules/dist would ride along with cp -R.
  rsync -a --exclude node_modules --exclude dist --exclude .claude "$PLUGIN_ROOT/src/" "$DAEMON_DIR/"
  # Use a data-dir-local npm cache to avoid the common ~/.npm root-owned EPERM.
  ( cd "$DAEMON_DIR" && npm install --no-audit --no-fund --cache "$DATA_DIR/.npm" && npm run build ) >&2
fi
if [ "$NEED_BUILD" = "1" ] || [ "$BUILD_STALE" = "1" ]; then
  mkdir -p "$DAEMON_DIR"
  jq -n --arg v "$PLUGIN_VERSION" --arg r "$PLUGIN_ROOT" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version: $v, pluginRoot: $r, builtAt: $t}' >"$DAEMON_DIR/build.json"
fi

# 2b) PocketBase store -------------------------------------------------------
# Resolve the effective provider the SAME way the daemon/board do (see
# src/lib/config.ts): explicit db_provider wins; else firestore iff a cloud
# project is configured; else pocketbase (the zero-config local default).
PB_VERSION=0.39.2
# The raw names in $DATA_DIR/.env count too (the daemon and board load that file).
envval() { [ -f "$DATA_DIR/.env" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}[[:space:]]*$/\1/p" "$DATA_DIR/.env" | tail -1; }
: "${CLAUDE_PLUGIN_OPTION_db_provider:=$(envval DB_PROVIDER)}"
: "${CLAUDE_PLUGIN_OPTION_firestore_mode:=$(envval FIRESTORE_MODE)}"
: "${CLAUDE_PLUGIN_OPTION_gcp_project_id:=$(envval FIREBASE_PROJECT_ID)}"
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

# 2c) Firestore key check -----------------------------------------------------
if [ "$DBP" = "firestore" ]; then
  FS_CRED="${CLAUDE_PLUGIN_OPTION_firestore_credentials:-$(envval FIRESTORE_CREDENTIALS)}"
  if [ -n "$FS_CRED" ] && [ ! -r "$(expand_home "$FS_CRED")" ]; then
    echo "[ks-flow] Firestore key $FS_CRED is not readable — the daemon can't reach the store (ks-setup store firestore ...)" >&2
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
  # firestore_client_email / firestore_private_key are left out on purpose: the
  # plist is a plain-text file, and a private key doesn't belong in it. Point
  # firestore_credentials (or FIRESTORE_CREDENTIALS in $CLAUDE_PLUGIN_DATA/.env,
  # which the daemon loads itself) at the key file instead.
  for k in project_path workflow_user db_provider firestore_mode gcp_project_id \
           firestore_credentials \
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
  elif { [ "$NEED_BUILD" = "1" ] || [ "$BUILD_STALE" = "1" ]; } && [ -z "${KS_FLOW_NO_RESTART:-}" ]; then
    # Rebuilt the daemon (or its version changed) but the plist didn't — the
    # running process is still on old code, so restart it to load the fresh dist.
    launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    echo "[ks-flow] daemon restarted (new build)" >&2
  fi
fi
exit 0
