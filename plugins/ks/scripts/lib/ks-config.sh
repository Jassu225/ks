# lib/ks-config.sh — the KS config reader for shell scripts. Source it:
#   . "<scripts>/lib/ks-config.sh"
#   root="$(ksc_get KS_PROJECT_ROOT_PATH)"
#
# Lookup order, the same as lib/env.ts:
#   1. the real environment
#   2. the KS store: secrets in the macOS Keychain (service ks.<namespace>,
#      account <KEY>), plain values in ${KS_CONFIG_DIR:-~/.config/ks}/<ns>.env
#   3. the legacy files: scripts/.env, then the plugin's .config (read only;
#      `ks-config import-legacy` moves them into the store)
# Keys and their namespaces: lib/ks-config-keys.txt.
# KS_SECURITY_BIN overrides the `security` binary (tests use a fake).

_KSC_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KSC_SCRIPTS_DIR="$(cd "$_KSC_LIB/.." && pwd)"
KSC_PLUGIN_DIR="$(cd "$KSC_SCRIPTS_DIR/.." && pwd)"
KSC_KEYS_FILE="$_KSC_LIB/ks-config-keys.txt"

ksc_dir() { printf '%s' "${KS_CONFIG_DIR:-$HOME/.config/ks}"; }
ksc_security() { printf '%s' "${KS_SECURITY_BIN:-/usr/bin/security}"; }

# Legacy files, in order. KSC_LEGACY_FILES (space-separated) overrides, for tests.
ksc_legacy_files() {
  if [ -n "${KSC_LEGACY_FILES+x}" ]; then printf '%s\n' $KSC_LEGACY_FILES; return; fi
  printf '%s\n' "$KSC_SCRIPTS_DIR/.env" "$KSC_PLUGIN_DIR/.config"
}

# "<ns> <secret|plain>" for a known key; nothing for an unknown one.
ksc_meta() {
  awk -v k="$1" '!/^#/ && $2 == k { print $1, $3; exit }' "$KSC_KEYS_FILE"
}
ksc_ns() { ksc_meta "$1" | cut -d' ' -f1; }
ksc_is_secret() { [ "$(ksc_meta "$1" | cut -d' ' -f2)" = "secret" ]; }

# Value of KEY in a KEY=VALUE file (last one wins, quotes stripped).
ksc_file_value() {
  [ -f "$2" ] || return 1
  local v
  v="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" "$2" 2>/dev/null | tail -1)"
  [ -n "$v" ] || return 1
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

ksc_keychain_value() {
  "$(ksc_security)" find-generic-password -s "ks.$1" -a "$2" -w 2>/dev/null
}

# Where KEY comes from: env | keychain | config | legacy | unset (never the value).
ksc_source() {
  local key="$1" ns f
  if [ -n "${!key:-}" ]; then echo env; return; fi
  ns="$(ksc_ns "$key")"
  if [ -n "$ns" ]; then
    if ksc_is_secret "$key"; then
      [ -n "$(ksc_keychain_value "$ns" "$key")" ] && { echo keychain; return; }
    else
      ksc_file_value "$key" "$(ksc_dir)/$ns.env" >/dev/null && { echo config; return; }
    fi
  fi
  while read -r f; do
    ksc_file_value "$key" "$f" >/dev/null && { echo legacy; return; }
  done < <(ksc_legacy_files)
  echo unset
}

# The value of KEY by the lookup order; exit 1 when unset.
ksc_get() {
  local key="$1" ns v f
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return 0; fi
  ns="$(ksc_ns "$key")"
  if [ -n "$ns" ]; then
    if ksc_is_secret "$key"; then
      v="$(ksc_keychain_value "$ns" "$key")" && [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    else
      v="$(ksc_file_value "$key" "$(ksc_dir)/$ns.env")" && { printf '%s' "$v"; return 0; }
    fi
  fi
  while read -r f; do
    v="$(ksc_file_value "$key" "$f")" && { printf '%s' "$v"; return 0; }
  done < <(ksc_legacy_files)
  return 1
}

# Export every PLAIN key that is set somewhere and not in the env yet (for
# launchers). Secrets are never exported: each CLI reads its own from the Keychain.
ksc_export_plain() {
  local key v
  while read -r key; do
    [ -n "${!key:-}" ] && continue
    v="$(ksc_get "$key")" && export "$key=$v"
  done < <(awk '!/^#/ && NF >= 3 && $3 == "plain" { print $2 }' "$KSC_KEYS_FILE")
}

# The KarmaSuite checkout: KS_PROJECT_ROOT_PATH by the lookup order, then the
# legacy PROJECT_ROOT_PATH key of old .config files. Exit 1 when unset.
ksc_project_root() {
  local v f
  v="$(ksc_get KS_PROJECT_ROOT_PATH)" && { printf '%s' "$v"; return 0; }
  while read -r f; do
    v="$(ksc_file_value PROJECT_ROOT_PATH "$f")" && { printf '%s' "$v"; return 0; }
  done < <(ksc_legacy_files)
  return 1
}
