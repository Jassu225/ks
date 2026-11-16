---
name: setup
description: Set up or check the KS plugins on this machine — tools, the plugin folders, command shims and PATH, the config and Keychain secrets, the sandbox excludes, ks-flow's store and daemon. Use when asked to set up, install, configure or repair the KS / KarmaSuite plugins, after a fresh install, when a ks command is not found, a token is missing, or a SessionStart note says KS setup is incomplete; or runs /ks:setup.
---

# Set up the KS plugins

One tool does the work: `ks-setup` (the ks plugin's `scripts/ks-setup`, also
in its `bin/`). Run it as the first word of a Bash command; it is in the
sandbox's excluded commands once set up. If `ks-setup` is not found, use
`"${CLAUDE_PLUGIN_ROOT}/scripts/ks-setup"`.

## 1. Check

```bash
ks-setup doctor --json
```

`{mode, errors, checks: [{id, level, ok, message, fix}]}`. `mode` is
`marketplace` (installed), `dev-marketplace` (a clone loaded as a directory
marketplace) or `launcher` (only claude-ks loads the plugins). Report the
failing checks grouped by level (errors first), each with its fix.

**`sandbox:ks-setup` failing comes first, before anything else.** The sandbox
is on and runs `ks-setup` inside it, so nothing below can write what it needs.
Give `! ks-setup claude-settings --self` (it excludes only `ks-setup`), say
why in one line, and wait for it before step 2.

## 2. Apply what needs no secret and no consent

```bash
ks-setup apply
```

It creates `~/.config/ks/`, records the plugin folders, writes command shims to
`~/.local/bin` and adds that folder to PATH in the user's shell startup file
(zsh: `~/.zshrc`; bash: `~/.bash_profile` on macOS, else `~/.bashrc`). When it
can't tell the shell or write the file, it prints the line: hand that line
over as a `!` command. It installs the CLI dependencies in a clone.

Before running it, ask (AskUserQuestion) for anything it would otherwise ask
in a terminal:
- the KarmaSuite checkout path when `config:KS_PROJECT_ROOT_PATH` failed →
  `ks-config set ks.KS_PROJECT_ROOT_PATH <path>` (a plain value: run it);
- for a clone in `launcher` mode: whether to load the clone as the karmasuite
  directory marketplace (`ks-setup apply --dev --yes`), so plain `claude`, the
  desktop app and IDEs get the plugins.

Plugins are installed **per project, never user-wide**: inside the KarmaSuite
checkout, with `--scope local`, so only that checkout loads them (the switch
lives in its gitignored `.claude/settings.local.json`). When a `plugin:*` check
fails, give `! cd <checkout> && claude plugin install --scope local <plugin>@karmasuite`.
`ks-setup apply` copies the switches into the project's existing worktrees;
`create-worktree` does it for new ones.

### Claude's settings: ask, then run it yourself

When the `sandbox` or `secrets:deny` check fails (and `ks-setup` itself is
excluded), ask with AskUserQuestion, listing what `ks-setup claude-settings`
would add to `~/.claude/settings.json`: the KS commands in
`sandbox.excludedCommands` (only with the sandbox on; `ks-flow`'s entry only
when ks-flow is enabled in the project), the deny rules that keep you from
reading the Keychain, and the statusline env. On yes, run
`ks-setup claude-settings --yes` yourself (add `--ks-flow` if they want
ks-flow but it isn't enabled yet). On no, leave it.

## 3. Steps the user runs (never run these yourself)

Give each as a `!` command, one per line, and wait:
- secrets — never ask for a token in chat:
  `! ks-config secret linear.LINEAR_API_KEY` (also `slack.SLACK_TOKEN`,
  `grain.GRAIN_API_TOKEN` when those checks failed);
- old tokens in `plugins/ks/scripts/.env`: `! ks-config import-legacy`;
- (`sandbox:ks-setup`, if it still fails: `! ks-setup claude-settings --self`.)
- the KS status line, optional: ask first (AskUserQuestion) whether they want
  it (session, context, branch, ticket, rate limits) in the KarmaSuite checkout,
  unless `statusline:project` is ok; on yes `! ks-setup statusline --yes`. It
  sets the checkout's own `.claude/settings.local.json` and its worktrees, never
  `~/.claude/settings.json`;
- Remote Control in the project, optional: the doctor's `remote-control`
  check. With 2+ devices on the ks-flow board it is a `warn`: suggest it (ask
  with AskUserQuestion), since without it agents on different Macs can't
  message each other. With one Mac it is `info`: mention it once as optional,
  don't push. On yes `! ks-setup remote-control --yes`: a `claude` shell
  function in the shell's startup file that adds `--rc` in the KarmaSuite
  checkout and its worktrees only (Claude has no per-project setting for it);
  `--remove` takes it out. Say that Remote Control keeps those transcripts on
  Anthropic's servers;
- ks-flow's store, when the user wants Firestore:
  `! ks-setup store firestore --project <gcp id> --credentials <key.json>`,
  then `! ks-flow stop && ks-flow start && ks-flow open`.

## 4. Verify

Run `ks-setup doctor` again and report what is left. A new shell (for PATH) or
a new Claude session (for plugin changes and installed dependencies) may be
needed; say which.
