---
name: config
description: Read or change the KS plugins' configuration — the KarmaSuite project path, the Linear / Slack / Grain tokens, the backup bucket, ks-flow's store and Briefing settings. Use when asked what is configured, to set, change, rotate or remove a token or setting, or runs /ks:config.
---

# KS config

Tokens are secrets in the macOS Keychain (service `ks.<namespace>`); plain
settings are in `~/.config/ks/<namespace>.env`. Both are read and written only
through `ks-config` (first word of the command). The real environment wins over
the store, and the store over the old `plugins/ks/scripts/.env`.

## Show

```bash
ks-config list            # or: ks-config list <namespace>, ks-config list --json
```

Columns: namespace, key, secret/plain, source (`env`, `keychain`, `config`,
`legacy`, `unset`), value (secrets show only `(set)`). Present it grouped by
namespace. `legacy` means it still comes from the old file: suggest
`! ks-config import-legacy`.

## Change

- Plain value: `ks-config set <ns>.<KEY> <value>`; remove: `ks-config unset <ns>.<KEY>`.
  Run these.
- Secret: never ask for the value in chat and never pass it as an argument.
  Give the user `! ks-config secret <ns>.<KEY>` (hidden input), then run
  `ks-config list <ns>` to confirm it shows `(set)`.
- Unknown keys are refused; the list of keys is `ks-config list`.

## ks-flow settings (per project)

- The store: `! ks-setup store pocketbase` or
  `! ks-setup store firestore --project <gcp id> --credentials <key.json>`.
- The Briefing schedule, names and the other board settings: the board's
  `/settings` page (each section has its own Save).

## After a change

- CLIs (`linear`, `slack`, `grain`): the next command uses it.
- ks-flow daemon and board: `! ks-flow restart` (`ks-flow open` opens the board).
- Hooks and the session's PATH: a new Claude session.
