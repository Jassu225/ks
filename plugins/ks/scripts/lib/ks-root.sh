# lib/ks-root.sh — find a KS plugin's folder, the same whether the repo is a
# clone or the plugins are installed from the karmasuite marketplace. Source it:
#   . "<scripts>/lib/ks-root.sh"
#   flow="$(ks_root ks-flow)" || exit 1
#
# Never store a path into a versioned plugin-cache folder
# (~/.claude/plugins/cache/karmasuite/<name>/<version>): an update leaves the old
# folder behind, so a stored path keeps running old code. The current folder is
# derived from Claude Code's own files on every call instead.
#
# Resolution order (the first that names an existing folder wins):
#   1. KS_ROOT_<NAME>  (name upper-cased, - → _; e.g. KS_ROOT_KS_FLOW)
#   2. the directory marketplace: when known_marketplaces.json's `karmasuite`
#      is a directory source, <installLocation>/plugins/<name> (its plugin.json
#      must declare <name>; the clone is read in place, and installed_plugins.json
#      then still lists stale cache entries)
#   3. installed_plugins.json's <name>@karmasuite entries, best first: a
#      local/project entry whose projectPath holds $PWD (the longest), the KS
#      checkout's (KS_PROJECT_ROOT_PATH, env or ${KS_CONFIG_DIR}/ks.env), a
#      user/managed one, then the rest; ties by highest version. An entry whose
#      installPath is gone is skipped.
#   4. the registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json, `mode: local`
#      entries only (a clone loaded some other way, e.g. --plugin-dir)
#   5. the sibling folder next to this plugin (a clone: plugins/<name>)
#   6. ks_root only: `claude plugin list --json` (readFromFolder, else
#      installPath). The shims never spawn `claude`.
# Steps 1-5 are one jq call over the three files (KSR_JQ), the same text the
# ~/.local/bin shims carry inline (ksr_write_shim), and the same order as
# ks-flow's src/lib/ksroot.ts liveRoot. KS_CLAUDE_BIN overrides `claude` (tests).

_KSR_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KSR_PLUGIN_DIR="$(cd "$_KSR_LIB/../.." && pwd)"
KSR_PLUGINS_DIR="$(cd "$KSR_PLUGIN_DIR/.." && pwd)"

ksr_registry() { printf '%s/plugins.json' "${KS_CONFIG_DIR:-$HOME/.config/ks}"; }
ksr_cache_dir() { printf '%s/plugins/cache/' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; }

# The plugin name a folder declares in .claude-plugin/plugin.json.
ksr_declared_name() {
  jq -r '.name // empty' "$1/.claude-plugin/plugin.json" 2>/dev/null
}

# Steps 1-5 as candidate lines "<flag> <folder>", best first; flag `v` = the
# folder is a guess whose plugin.json name must match, `-` = taken as is.
# Inputs: $n plugin name, $sib sibling folder (or ""), $cwd, $proj
# (KS_PROJECT_ROOT_PATH from env, or ""), and the raw text of
# known_marketplaces.json ($kmr), installed_plugins.json ($ipr), the registry
# ($rgr) and ks.env ($kse), each "" when missing (unparsable = missing).
# No single quote in this text: the shims embed it in '...'.
KSR_JQ='def trim: if type == "string" then rtrimstr("/") else "" end;
def json($s): $s | fromjson? // null;
def ver: [(.version // "0" | tostring | splits("[.+-]") | tonumber? // 0)] + [0, 0, 0] | .[0:3] | map(-.);
($cwd | trim) as $cwd
| (if $proj != "" then $proj
   else [$kse | splits("\n") | capture("^\\s*(export\\s+)?KS_PROJECT_ROOT_PATH\\s*=\\s*(?<v>.*?)\\s*$")? | .v] | last // ""
   end | gsub("^[\"\u0027]|[\"\u0027]$"; "")
   | if . == "~" then ($ENV.HOME // "") elif startswith("~/") then ($ENV.HOME // "") + .[1:] else . end
   | trim) as $ks
| ([json($kmr) | objects | .karmasuite][0]) as $mk
| ($ENV["KS_ROOT_" + ($n | ascii_upcase | gsub("-"; "_"))] // empty | select(. != "") | "- " + .),
  ($mk | objects | select(.source.source? == "directory") | (.installLocation // .source.path) | strings
   | "v " + trim + "/plugins/" + $n),
  ([json($ipr) | objects | .plugins | objects | .[$n + "@karmasuite"] // empty
    | if type == "array" then .[] else . end | objects
    | select(.installPath | type == "string")
    | (.projectPath | trim) as $pp
    | (if (.scope == "local" or .scope == "project") and $pp != "" and ($cwd == $pp or ($cwd | startswith($pp + "/"))) then 0
       elif $pp != "" and $pp == $ks then 1
       elif .scope == "user" or .scope == "managed" then 2
       else 3 end) as $r
    | {p: .installPath, r: $r, l: (if $r == 0 then -($pp | length) else 0 end), v: ver}]
   | sort_by(.r, .l, .v) | .[] | "- " + .p),
  (json($rgr) | objects | .[$n] | objects | select(.mode == "local") | .root | strings | "- " + .),
  ($sib | select(. != "") | "v " + .)'

ksr_candidates() { # name [sibling]
  local pd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins" kd="${KS_CONFIG_DIR:-$HOME/.config/ks}"
  local km="$pd/known_marketplaces.json" ip="$pd/installed_plugins.json" rg="$kd/plugins.json" ke="$kd/ks.env"
  [ -r "$km" ] || km=/dev/null; [ -r "$ip" ] || ip=/dev/null
  [ -r "$rg" ] || rg=/dev/null; [ -r "$ke" ] || ke=/dev/null
  jq -nr --arg n "$1" --arg sib "${2:-}" --arg cwd "$PWD" --arg proj "${KS_PROJECT_ROOT_PATH:-}" \
    --rawfile kmr "$km" --rawfile ipr "$ip" --rawfile rgr "$rg" --rawfile kse "$ke" "$KSR_JQ" 2>/dev/null
}

# The folder <name> runs from now (steps 1-5); exit 1 when none. Never spawns claude.
ksr_live_root() {
  local name="$1" l c
  [ -n "$name" ] || return 1
  while IFS= read -r l; do
    c="${l#? }"
    [ -n "$c" ] && [ -d "$c" ] || continue
    if [ "${l%% *}" = v ] && [ "$(ksr_declared_name "$c")" != "$name" ]; then continue; fi
    printf '%s' "$c"; return 0
  done < <(ksr_candidates "$name" "$KSR_PLUGINS_DIR/$name")
  return 1
}

ks_root() {
  local name="$1" v
  [ -n "$name" ] || return 1
  ksr_live_root "$name" && return 0
  v="$("${KS_CLAUDE_BIN:-claude}" plugin list --json 2>/dev/null | jq -r --arg n "$name" '
      [ .[]? | select((.id // "") | startswith($n + "@")) ]
      | sort_by(.lastUpdated // "") | last
      | if . == null then empty else (.readFromFolder // .installPath // empty) end' 2>/dev/null)"
  if [ -n "$v" ] && [ -d "$v" ]; then printf '%s' "$v"; return 0; fi
  return 1
}

# <name>'s folder in the karmasuite marketplace's own copy of the repo,
# installed or not: a clone (directory marketplace) or Claude Code's clone of
# the GitHub repo (~/.claude/plugins/marketplaces/karmasuite), which every
# marketplace update refreshes. The on-demand plugins (ks-master, ks-browser)
# load from here with --plugin-dir, so they need no install on any machine.
ksr_marketplace_root() {
  local d
  d="$(jq -r '.karmasuite | (.installLocation // .source.path) // empty' \
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/known_marketplaces.json" 2>/dev/null)"
  d="${d%/}"
  [ -n "$d" ] && [ -d "$d/plugins/$1" ] && [ "$(ksr_declared_name "$d/plugins/$1")" = "$1" ] || return 1
  printf '%s' "$d/plugins/$1"
}

# Record <name> → <root> in the registry as a local (clone) root. A root under
# the plugin cache is never recorded, and `mode: marketplace` entries (written
# before the resolver read Claude's files) are dropped. Quiet and best effort:
# a registry write never fails a hook.
ks_register_root() {
  local name="$1" root="$2" reg tmp
  [ -n "$name" ] && [ -d "$root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  reg="$(ksr_registry)"
  case "$root" in "$(ksr_cache_dir)"*|"$HOME/.claude/plugins/cache/"*) root="" ;; esac
  if [ -z "$root" ]; then # only a prune, and only when there is something to drop
    jq -e 'any(.[]?; .mode? == "marketplace")' "$reg" >/dev/null 2>&1 || return 0
  fi
  mkdir -p "$(dirname "$reg")" 2>/dev/null || return 0
  tmp="$reg.tmp.$$"
  { [ -s "$reg" ] && cat "$reg" || echo '{}'; } 2>/dev/null \
    | jq --arg n "$name" --arg r "$root" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        with_entries(select(.value.mode? != "marketplace"))
        | if $r == "" then . else .[$n] = {root: $r, mode: "local", seenAt: $t} end' >"$tmp" 2>/dev/null \
    && mv "$tmp" "$reg" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}

# Write the ~/.local/bin shim (or <dir>/<cmd>) that runs <plugin>'s bin/<cmd>.
# Self-contained: it resolves the folder with KSR_JQ itself on every run (no
# baked-in root, no sibling, never `claude`), so a plugin update needs no
# rewrite. Atomic (a running shim is never overwritten in place). The folder
# list comes in on fd 3, closed for the command, so the command keeps the
# caller's stdin (a terminal for `ks-config secret`'s hidden prompt, or a
# pipe); v2 read it on stdin, which the command then inherited.
KSR_SHIM_MARK='# ks-shim v3'
ksr_write_shim() { # plugin cmd [dir]
  local plug="$1" cmd="$2" dir="${3:-$HOME/.local/bin}" f tmp
  [ -n "$plug" ] && [ -n "$cmd" ] || return 1
  f="$dir/$cmd"; tmp="$f.tmp.$$"
  mkdir -p "$dir" || return 1
  {
    printf '#!/bin/bash\n%s\n' "$KSR_SHIM_MARK"
    printf '# Written by ks-setup: runs the %s plugin'"'"'s bin/%s from the folder Claude\n' "$plug" "$cmd"
    printf '# loads it from now (KS_ROOT_*, directory marketplace, installed_plugins.json,\n'
    printf '# local registry entry), looked up on every run. See lib/ks-root.sh.\n'
    printf 'n=%q c=%q\n' "$plug" "$cmd"
    cat <<'EOF'
pd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins" kd="${KS_CONFIG_DIR:-$HOME/.config/ks}"
km="$pd/known_marketplaces.json" ip="$pd/installed_plugins.json" rg="$kd/plugins.json" ke="$kd/ks.env"
[ -r "$km" ] || km=/dev/null; [ -r "$ip" ] || ip=/dev/null
[ -r "$rg" ] || rg=/dev/null; [ -r "$ke" ] || ke=/dev/null
while IFS= read -r r <&3; do
  r="${r#? }"
  [ -n "$r" ] && [ -x "$r/bin/$c" ] && exec "$r/bin/$c" "$@" 3<&-
done 3< <(jq -nr --arg n "$n" --arg sib "" --arg cwd "$PWD" --arg proj "${KS_PROJECT_ROOT_PATH:-}" \
  --rawfile kmr "$km" --rawfile ipr "$ip" --rawfile rgr "$rg" --rawfile kse "$ke" '
EOF
    printf '%s' "$KSR_JQ"
    cat <<'EOF'
' 2>/dev/null)
echo "$c: the $n plugin was not found (needs jq); run /ks:setup" >&2
exit 127
EOF
  } >"$tmp" && chmod +x "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; return 1; }
}

# Rewrite every shim in <dir> older than this version: v1 (`# ks shim`: a
# baked-in, versioned folder) and v2 (the command inherited the folder list as
# its stdin). Returns 0 when it rewrote any.
ksr_upgrade_shims() { # [dir]
  local dir="${1:-$HOME/.local/bin}" f plug n=0
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.tmp.*) continue ;; esac
    grep -q '^# ks shim\|^# ks-shim v' "$f" 2>/dev/null || continue
    grep -qxF "$KSR_SHIM_MARK" "$f" 2>/dev/null && continue
    plug="$(sed -n 's/^n=\([^ ]*\) c=.*/\1/p' "$f" | head -1)"
    [ -n "$plug" ] || plug="$(sed -n 's/.*\.\["\([^"]*\)"\]\.root.*/\1/p' "$f" | head -1)"
    [ -n "$plug" ] || continue
    ksr_write_shim "$plug" "$(basename "$f")" "$dir" && n=$((n + 1))
  done
  [ "$n" -gt 0 ]
}
