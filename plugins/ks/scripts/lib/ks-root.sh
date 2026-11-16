# lib/ks-root.sh — find a KS plugin's folder, the same whether the repo is a
# clone or the plugins are installed from the karmasuite marketplace. Source it:
#   . "<scripts>/lib/ks-root.sh"
#   flow="$(ks_root ks-flow)" || exit 1
#
# Resolution order (the first that names an existing folder wins):
#   1. KS_ROOT_<NAME>  (name upper-cased, - → _; e.g. KS_ROOT_KS_FLOW)
#   2. the registry ${KS_CONFIG_DIR:-~/.config/ks}/plugins.json, written by each
#      plugin's SessionStart hook from ${CLAUDE_PLUGIN_ROOT} (so it follows
#      version updates) and by `ks-setup apply` for a clone
#   3. the sibling folder next to this plugin (a clone: plugins/<name>)
#   4. `claude plugin list --json`: readFromFolder (a directory marketplace is
#      read in place), else installPath, for <name>@<any marketplace>
# KS_CLAUDE_BIN overrides `claude` (tests use a stub).

_KSR_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KSR_PLUGIN_DIR="$(cd "$_KSR_LIB/../.." && pwd)"
KSR_PLUGINS_DIR="$(cd "$KSR_PLUGIN_DIR/.." && pwd)"

ksr_registry() { printf '%s/plugins.json' "${KS_CONFIG_DIR:-$HOME/.config/ks}"; }

# The plugin name a folder declares in .claude-plugin/plugin.json.
ksr_declared_name() {
  jq -r '.name // empty' "$1/.claude-plugin/plugin.json" 2>/dev/null
}

ks_root() {
  local name="$1" var v
  [ -n "$name" ] || return 1
  var="KS_ROOT_$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')"
  v="${!var:-}"
  if [ -n "$v" ] && [ -d "$v" ]; then printf '%s' "$v"; return 0; fi

  v="$(jq -r --arg n "$name" '.[$n].root // empty' "$(ksr_registry)" 2>/dev/null)"
  if [ -n "$v" ] && [ -d "$v" ]; then printf '%s' "$v"; return 0; fi

  v="$KSR_PLUGINS_DIR/$name"
  if [ -d "$v" ] && [ "$(ksr_declared_name "$v")" = "$name" ]; then printf '%s' "$v"; return 0; fi

  v="$("${KS_CLAUDE_BIN:-claude}" plugin list --json 2>/dev/null | jq -r --arg n "$name" '
      [ .[]? | select((.id // "") | startswith($n + "@")) ]
      | sort_by(.lastUpdated // "") | last
      | if . == null then empty else (.readFromFolder // .installPath // empty) end' 2>/dev/null)"
  if [ -n "$v" ] && [ -d "$v" ]; then printf '%s' "$v"; return 0; fi
  return 1
}

# Record <name> → <root> in the registry (mode: marketplace for a cache copy,
# else local). Quiet and best effort: a registry write never fails a hook.
ks_register_root() {
  local name="$1" root="$2" reg mode tmp
  [ -n "$name" ] && [ -d "$root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  reg="$(ksr_registry)"
  case "$root" in "$HOME/.claude/plugins/cache/"*) mode=marketplace ;; *) mode=local ;; esac
  mkdir -p "$(dirname "$reg")" 2>/dev/null || return 0
  tmp="$reg.tmp.$$"
  { [ -s "$reg" ] && cat "$reg" || echo '{}'; } 2>/dev/null \
    | jq --arg n "$name" --arg r "$root" --arg m "$mode" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.[$n] = {root: $r, mode: $m, seenAt: $t}' >"$tmp" 2>/dev/null \
    && mv "$tmp" "$reg" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}
