---
name: setup
description: Set up or check the KS plugins on this machine — tools, the plugin folders, command shims and PATH, the config and Keychain secrets, the sandbox excludes, ks-flow's store and daemon. Use when asked to set up, install, configure or repair the KS / KarmaSuite plugins, after a fresh install, when a ks command is not found, a token is missing, or a SessionStart note says KS setup is incomplete; or runs /ks:setup.
---

# Set up the KS plugins

One tool does the work: `ks-setup` (the ks plugin's `scripts/ks-setup`, also
in its `bin/`). Run it alone in a Bash command, as the first word, never by
its full path and never after `&&`, `;` or before a pipe: only then does the
sandbox exclusion apply (inside the sandbox it can't read ks-flow's `.env` or
ask launchd, and reports a wrong store and "daemon not loaded"). (The ks plugin's
`bin/` is on your PATH, so it is found before setup too. If it isn't, the full
path `"${CLAUDE_PLUGIN_ROOT}/scripts/ks-setup"` runs inside the sandbox: only
`doctor` works that way.)

## 1. Check

```bash
ks-setup doctor --json
```

`{mode, errors, checks: [{id, level, ok, message, fix}]}`. `mode` is
`marketplace` (installed), `dev-marketplace` (a clone loaded as a directory
marketplace) or `launcher` (only claude-ks loads the plugins). Report the
failing checks grouped by level (errors first), each with its fix.

**Who runs a fix.** A fix that starts with `!` is the user's: give it as a `!`
command and wait. Every other fix is a KS command the sandbox excludes, so you
run it yourself: ask first (AskUserQuestion) when it installs something or
changes a file outside `~/.config/ks`, then run it with `--yes`. Never hand the
user a command you can run.

**`sandbox:ks-setup` failing comes first, before anything else.** The sandbox
is on and runs `ks-setup` inside it, so nothing below can write what it needs.
Give `! ks-setup claude-settings --self` (it excludes only `ks-setup`), say
why in one line, and wait for it before step 2.

## 2. Run, after asking where needed

- **Project path**, when `config:KS_PROJECT_ROOT_PATH` failed: ask for the
  KarmaSuite checkout (the folder Claude runs in is the likely answer), then
  `ks-config set ks.KS_PROJECT_ROOT_PATH <path>`.
- **Tools** (`tool:*`, `master`): ask, listing what is missing, then
  `ks-setup tools --yes <names>` (Homebrew; it installs only the tools setup
  checks). If it says Homebrew is missing, give the user https://brew.sh: its
  installer needs their password.
- **`ks-setup apply`**: no question needed. It creates `~/.config/ks/`, records
  a clone's plugin folders (installed ones are found live), writes command
  shims to `~/.local/bin` and adds that
  folder to PATH in the shell's startup file (zsh: `~/.zshrc`; bash:
  `~/.bash_profile` on macOS, else `~/.bashrc`), installs the CLI dependencies
  in a clone and copies the plugin switches into existing worktrees. For a
  clone in `launcher` mode, first ask whether to load the clone as the
  karmasuite directory marketplace (`ks-setup apply --dev --yes`), so plain
  `claude`, the desktop app and IDEs get the plugins; an installed machine
  answers no.
- **Claude's settings** (`sandbox`, `secrets:deny`, `settings:statusline`):
  ask, listing what `ks-setup claude-settings` adds to `~/.claude/settings.json`:
  the KS commands in `sandbox.excludedCommands` (only with the sandbox on;
  `ks-flow`'s entry only when ks-flow is enabled in the project), the deny rules
  that keep you from reading the Keychain, and the statusline env. On yes
  `ks-setup claude-settings --yes` (add `--ks-flow` if they want ks-flow but it
  isn't enabled yet).
- **Old tokens** in `plugins/ks/scripts/.env`: ask, then `ks-config import-legacy`.
- **The KS status line**, optional: unless `statusline:project` is ok, ask
  whether they want it (session, context, branch, ticket, rate limits) in the
  KarmaSuite checkout; on yes `ks-setup statusline --yes`. It sets the
  checkout's own `.claude/settings.local.json` and its worktrees, never
  `~/.claude/settings.json`.
- **Remote Control in the project**, optional: the `remote-control` check. With
  2+ devices on the ks-flow board it is a `warn`: suggest it, since without it
  agents on different Macs can't message each other. With one Mac it is `info`:
  mention it once as optional, don't push. Say that Remote Control keeps those
  transcripts on Anthropic's servers. On yes `ks-setup remote-control --yes`:
  sets `ks.KS_REMOTE_CONTROL=1`, so sessions started with `claude-ks` get
  `--rc` (Claude has no per-project setting for it; a plain `claude` is
  unchanged); `--remove` unsets it. `remote-control:shell` (warn): the old
  `claude` shell function an earlier setup wrote is still in the shell's
  startup file; ask, then `ks-setup remote-control --yes` removes it.
- **ks-flow's store**, when they want the shared Firestore board: they copy the
  service-account key file onto the Mac themselves (never through chat or git)
  and tell you its path; then ask and run
  `ks-setup store firestore --project <gcp id> --credentials <key.json>`.
- **ks-flow's daemon** (`ks-flow:daemon`, `ks-flow:version`): ask, then
  `ks-flow start` (after a store change, `ks-flow stop && ks-flow start`), and
  `ks-flow open` for the board.
- **Updating** (`plugins:copies`, `ks-flow:release`, a version behind, or asked
  to update): ask, then `ks-setup update`. It updates every KS plugin in the
  checkout and each worktree (a clone: `git pull --ff-only`, only on a clean
  `main`), rewrites the shims and restarts ks-flow; `ks-setup update --check`
  only looks. Exit 3 means another update is running: wait and check again.
  Open sessions reload themselves when idle; one that shows "run
  /reload-plugins" needs the user to run it.

Plugins are installed **per project, never user-wide**: inside the KarmaSuite
checkout, with `--scope local`, so only that checkout loads them (the switch
lives in its gitignored `.claude/settings.local.json`).

## 3. Steps only the user can do

Give each as a `!` command, one per line, and wait:
- **tokens**, typed with hidden input; never ask for a token in chat:
  `! ks-config secret linear.LINEAR_API_KEY` (also `slack.SLACK_TOKEN`,
  `grain.GRAIN_API_TOKEN` when those checks failed);
- **`sandbox:ks-setup`**: `! ks-setup claude-settings --self`;
- **a missing plugin** (`plugin:*`; `claude` is not sandbox-excluded):
  `! cd <checkout> && claude plugin install --scope local <plugin>@karmasuite`;
- **Homebrew itself**, when `ks-setup tools` reports it missing (https://brew.sh).

## 4. Verify

Run `ks-setup doctor` again and report what is left. For versions (asked which
version runs, or after an update), `ks-setup version`: per plugin the copy the
KS commands run, the one Claude loads and the marketplace's newest, plus
ks-flow's daemon and store, each with its fix when behind. A new shell (for PATH) or
a new Claude session (for plugin changes and installed dependencies) may be
needed; say which.
