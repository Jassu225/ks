# Releases

## 2026-11-17

- **Old tickets flooded the board (ks-flow 0.8.6, fixes 0.8.5):** 0.8.5 matched a `state.yaml` with no `worktree_dir` to the worktree that held it. But every worktree carries a copy of the whole `workflow/` folder, so each worktree claimed every old ticket without a recorded path (26 in one worktree) and they showed as live cards. Now a worktree claims a ticket only when its folder is the ticket's own (`kar-13509` or `kar-13509-…`, as `create-worktree` names it). The wrongly claimed cards drop back off the board on the next write.

- **A ticket whose worktree setup failed still gets its card (ks 1.3.11, ks-flow 0.8.5):**
  - **What happened:** on B, `ks-start-ticket` created KAR-13509's worktree, but `create-worktree` then failed at `pnpm install` (pnpm missing). It printed `WORKTREE_PATH=` only on its last line, so `ks-start-ticket` saw a failure, said "Failed to create worktree" and never recorded `worktree_dir`. With no worktree on record, ks-flow couldn't tie the card or its session to the folder, so the board hid the card. Any Mac whose dependency step fails would do the same; nothing earlier today changed this.
  - **`create-worktree`:** prints the path as soon as the worktree exists.
  - **`ks-start-ticket`:** when a later setup step fails, it still records `worktree_dir` (both copies), warns with the command to finish by hand, prints `KS_WARNING=` for `/ks:start-ticket`, and opens the session.
  - **ks-flow:** a `state.yaml` that sits inside a worktree but says `worktree_dir: null` now counts as that worktree's, so a ticket already left this way shows up with no edit.

- **`ks-flow inbox-check`: put the Plannotator Inbox right after a reboot (ks-flow 0.8.4, a stopgap):**
  - **The problem:** Tailscale keeps its `serve` mappings across a reboot, and the restarted Inbox refuses to publish over its own leftover mapping, or to reuse its link door's ("Another tailscale serve mapping already uses port …").
  - **What it checks:** Plannotator, Tailscale, the Inbox running, leftover mappings, the tailnet address and the linked Macs.
  - **What it fixes:** it removes the leftovers (only on the Inbox's or a link-door port, pointing at a loopback port nothing listens on), then starts or restarts the Inbox published, up to two rounds. `--dry-run` only reports.
  - **Until Plannotator fixes it:** remove the command once Plannotator reclaims its own mappings (in the backlog).

- **`ks-flow start` starts the board too (ks-flow 0.8.3):** it brought up only the daemon, so after `ks-flow stop && ks-flow start` the board stayed down until `ks-flow open`. `start` now also starts the board, building it first when its sources changed, without opening a browser tab. A board already running is kept. `ks-flow open` still opens it in the browser.

- **A restart no longer clears the NEEDS YOU sash (ks-flow 0.8.2):** on every daemon start (so every update), the cards were rebuilt and written before the daemon's first read of the Plannotator Inbox, which came on the first 15 s tick. Every card was written with no Inbox threads, and the sash and the Inbox wait went off on every board until the next write. The daemon now reads the Inbox once at start, before the first card write, as it already did for the last Linear status.
  - **The device chip gets its own row:** at the bottom of each card, as wide as the card, truncated only beyond that. In the footer beside the sessions it was cut off at about 10 characters.

- **The "run /reload-plugins" pill no longer sticks after the automatic reload (ks 1.3.10):** after a release, the ks module runs `/reload-plugins ks` by itself at an idle moment, then re-reads which versions are loaded. It did that re-read in its `command.run` hook, which catches a `/reload-plugins` you type. But a command a module runs itself skips that module's own hooks (`$.command.run` "runs through every hook but the calling one"). So after its own reload it still had the old versions on record, decided the reload hadn't taken, and showed "ks-flow 0.8.0 — run /reload-plugins" in every session until you typed it. It now re-reads the versions from its own run's answer too.

- **Open board tabs reload after an update (ks-flow 0.8.1):** an update rebuilds and restarts the board, but a tab left open kept the old page and showed stale information. Every tab now notices the new build (`/api/version` returns the build id; checked every 30 s and when the tab comes back into view) and reloads itself, waiting while you type in a field.

- **Another Mac's Inbox questions open on this Mac (ks-flow 0.8.0):** once the two Macs' Plannotator Inboxes are linked (Tailscale, `plannotator inbox link`, see ks 1.3.9), the NEEDS YOU sash and the Inbox rows on another Mac's card open **this** Mac's Inbox at that thread. It shows the other Mac's threads, and an answer reaches the agent there. The row reads "Inbox ↗ · B". Each daemon publishes its Inbox's id and the ids linked with it (`devices/{id}.inboxId`, `inboxLinks`, ids only from Plannotator's `machines.json`). Unlinked, the rows stay plain and say to link the Inboxes.
  - **An Inbox chip on the card:** "Inbox ↗" sits beside Slack and PR whenever the card has Inbox threads. It opens the first thread that waits on you, else the newest. "⏳ waiting: Inbox" now opens that thread too.

- **Setup suggests Plannotator (ks 1.3.9):** a new `ks-setup doctor` check, `plannotator`, looks for the `plannotator` binary and its Claude Code plugin (`plannotator@plannotator`, user scope). When either is missing, `/ks:setup` suggests it once, as an optional extra: plan and code review in the browser, and the Inbox, which ks-flow shows on the cards. The user installs it, since its installer downloads from plannotator.ai: `curl -fsSL https://plannotator.ai/install.sh | bash`, then `/plugin marketplace add backnotprop/plannotator` and `/plugin install plannotator@plannotator` in Claude, then a restart.
  - **Several Macs, one Inbox:** with 2+ Macs on the ks-flow board, three more checks guide the one-time steps that give every Mac one Inbox showing both Macs' threads (Plannotator's own linking). The user does all three.
    - `tailscale`: installed, running and logged in with one account on every Mac.
    - `plannotator:tailnet`: the Inbox is published on the tailnet at every start: the Inbox's "Over the tailnet" setting, HTTPS, only for the account that owns the Mac.
    - `plannotator:linked`: the Inboxes are linked once with a code (`plannotator inbox link --offer --tailscale`, then `plannotator inbox link <code>`). The link lasts until `plannotator inbox unlink`.

- **Ticket worktrees get KS updates too (ks 1.3.8):** a worktree's sessions were stuck on the KS version from the day the worktree was started.
  - **Why:** Claude writes its own install record for a worktree (in `installed_plugins.json`) when the first session starts there, at the version current then, without `auto`. Sessions there load that record.
  - **Nothing moved it:** Claude's auto-update skips a record without `auto`. `claude plugin update --scope local`, run in the worktree, takes the first local record, which is the main checkout's, whatever the folder.
  - **The visible symptom:** `ks-setup update` then saw "still 1.3.4 after the update" and marked every update failed, so ks-flow never rebuilt. B stayed on 0.5.2 from KAR-13509 on.
  - **The fix:** after updating the checkout's record, `ks-setup update` brings each worktree's record level with it (the same version, install folder and commit, `auto` on), and the release check counts them. Old versions stay in the plugin cache, so a running session keeps working until it reloads, which the ks mod does at an idle moment.
  - **Reported to Claude Code** as a bug.

- **The message board: commands for another Mac (ks-flow 0.7.0, ks 1.3.7, ks-master 0.1.1):** `ks-flow device-run <device> <command> [<arg>] [--from <who>] [--wait]` asks a device's ks-flow daemon to run one command on that Mac.
  - **Commands:** `start-ticket KAR-123` (worktree plus a new session in a new window), `new-session <checkout or worktree>`, `restart-session KAR-123`, `backup [unit]`, `ping`.
  - **How it runs:** each daemon follows its own commands with one listener, takes each once, runs it and writes the outcome back (ok or failed, a one-line message, the end of the output). A bad argument refuses it; one still queued after 15 min expires.
  - **The board's new Commands page** lists them live: who asked from which device, which device ran it, what, the status, the outcome and the output. `ks-flow commands` lists them in the terminal. They are kept 30 days.
  - **No free text:** commands carry none. Anyone holding the Firestore key could otherwise give a Claude session on your Macs its first message. A new session starts with the project-manager prompt or none.
  - **Who uses it:** the master's instructions and the KS rules now use it instead of asking someone's session to do errands (what happened with KAR-13509 on B).

- **A new session no longer looks like it replaced the old one (ks 1.3.6):** `claude-ks --dir` opened its tmux window in the foreground, so the terminal jumped to the new session and the one that ran it seemed to have ended (it was still running, one window over). The window now opens in the background and the command says where (`Ctrl-b <n>`). The KS rules now separate the two cases: "a new session" means one alongside this one (`claude-ks --dir`, `claude-ks-start`); `claude-ks-restart` replaces this session, only when the user asks; and a message from another session (a peer, the master) never authorizes ending your own. `ks-start-ticket` also takes a bare `KAR-123`, not only the Linear URL.

- **No timed Firestore reads, and an Errors page (ks-flow 0.6.0, ks 1.3.5):** nothing reads Firestore on a timer any more. Before, the board read and listed far more than it needed:

  | Who read it | What | How often |
  |---|---|---|
  | Each daemon | the whole `reminders` collection | every 30 s |
  | Each daemon | `meta/settings` and every device | every 60 s |
  | The master device | `masterRequests` | every 15 s |
  | Each daemon | the open Briefing items | every minute |
  | Each daemon | all `backupRuns`, until the day's sweep | every minute |
  | Every open board tab | all `backupRuns` twice, all `backupUnits` and a full bucket listing | every minute |
  | Every open board tab | `meta/settings` and the master's device | every 15 s |
  | The Activity page | all `backupRuns` | every 30 s |

  - **One listener per collection:** the daemon now follows each collection with one snapshot listener. That covers settings, devices, the cards other devices own, reminders, open items, the newest 100 runs, the backup index, and master requests on the master device. Its jobs read memory.
  - **One timer, every 15 s:** it first re-attaches any listener that stopped, then runs the due jobs.
  - **Board polls read files only:** the daemon writes `backup-status.json`, listing the bucket again only after a backup changes something, and keeps `devices.json` current on every change.
  - **Broken listeners fixed:** the card-owner listener had never run (Firestore refuses `select()` in a live query). The settings and master-requests listeners had stopped for good after network errors, and nothing restarted them.
  - **Errors page (`/errors`):** each daemon records what fails in `errors.json`: a listener that stopped (with when it tries again) or a job that keeps failing. You get a macOS notice when a problem opens and when it is fixed. A ⚠ in the board's header turns red with the count, and `ks-setup doctor` reports them (`ks-flow:errors`).

- **The ks version on the board (ks-flow 0.5.2):** the header shows `· ks <version>` beside ks-flow's, and the Processes page a "plugins on this Mac" line (ks, and ks-flow with the board's version when it differs from the daemon's). `/api/version` returns `ks`, read from the ks plugin's live folder.
- **No reload pill after a scripts-only ks release (ks 1.3.4):** the engine re-runs the ks mod only when the mod's own files change, not on a version change, so after 1.3.2 and 1.3.3 (scripts only) the mod kept its note of ks 1.3.1, and every `/reload-plugins` fell short of the target and left the pill. After a successful `/reload-plugins` the mod now re-reads every plugin's version, ks included (from its own folder), not only ks-flow and ks-master.

- **Another Mac's card with Inbox questions keeps its layout (ks-flow 0.5.1):** on a card owned by another device, each Inbox row ended with "Inbox on <the device's full name>", which never shrank, so a long name squeezed the row's text into a one-word column. The row now says "Inbox on A" (the device's label; the full name is in the tooltip), the label can shrink and truncate, and the text takes the row's width.

- **A status change keeps the ticket's place in the manual order (ks 1.3.3):** through the API, Linear moved an issue whose state changed without a `sortOrder`, while its own UI keeps the place. `linear issue update --state` now sends the issue's current `sortOrder` with the new state, unless `--position`, `--after` or `--before` asks for a new place. `linear issue batch-update --state` (one input for every issue) puts back the place of any issue the new state moved.

- **The `~/.local/bin` shims pass your input through (ks 1.3.2, shim v3):** a shim ran the command from inside its own `while read …; done < <(jq …)` loop, so the command's stdin was the shim's folder list, not your terminal or pipe. `ks-config secret` then found no terminal and read a folder path from that list as the secret (or nothing: "empty value"), and a piped value never arrived. That hit every Mac using the shims (an install); a clone with `plugins/ks/scripts` on PATH ran the scripts directly. Shims now read the list on fd 3 and close it for the command. v1 and v2 shims are rewritten at the next session start and by `ks-setup update`. `ks-config secret` with no terminal and nothing piped in now says so. **If you stored a secret through a shim before this, store it again.**

- **No stuck "run /reload-plugins" pill after a ks-flow-only release (ks 1.3.1):** on `/reload-plugins` the engine re-runs changed mods only, so when only ks-flow (or ks-master, neither of which has a mod) changed, the ks mod stayed with its old note of their versions. Its auto reload then counted the reload as "didn't take" and showed the pill, and a `/reload-plugins` typed by hand didn't clear it either. Now a `command.run` hook re-reads those plugins' versions after every successful `/reload-plugins`, typed or automatic, and the auto reload checks what's loaded before giving up. Shipping 1.3.1 also clears today's pills: ks itself changed, so every session's mod reloads fresh.

- **`ks-flow peers` (ks-flow 0.5.0, ks 1.3.0):** one table of every running Claude session on every Mac: device (`A · name`), peer name, ticket and its Linear title, state (working, idle, waiting on you, or last seen), the address to message (`bridge:session_…`, Remote Control's id), tmux pane and start time. `--md` prints it as Markdown, which agents now show as is (the KS rules' "Peers"); `--json` for scripts.
  - Each daemon publishes its sessions as `devices/{id}.sessions` within ~15 s of a change (a start or end, busy/idle, a wait). No prompt, transcript or path: the folder's name only. Cards still keep only the fixed fields, so busy/idle doesn't rewrite them.
  - **Removed:** the hand-made peers table (ListAgents matched to devices by `liveSessionNames`, then the label prefix). `liveSessionNames` is cleared from the store, and `ks-flow devices` lists devices only.
- **Fewer launchers (ks 1.3.0, ks-flow 0.5.0):** `claude-ks`, `claude-ks-start`, `claude-start`, `claude-ks-restart`, `claude-ks-master` and `claude-ks-test`, nothing else on PATH.
  - **New: `claude-ks-start [<dir>]` and `claude-start [<dir>]`** open a folder in a brand-new Ghostty window (else Terminal.app): a `claude-ks` session, or plain `claude`. With tmux, each runs in its own tmux session (closing the window detaches it; `claude-ks-restart` works there). `claude-ks-master`'s viewer uses the same opener (`lib/terminal.sh`).
  - **`claude-ks-rc` is now `claude-ks --dir <dir> [--pane <pane>]`:** starts a session in another folder (that tmux pane, else a new tmux window, else this terminal). A first message is claude's own positional prompt (no `--prompt`).
  - **`claude-ks-rc-restart` is now `claude-ks-restart`.** Remote Control follows the setting like any `claude-ks` session; `--rc` turns it on for the new session regardless (the restart used to force it). Log: `~/Library/Logs/claude-ks-restart.log`. The ks-flow daemon's hard restart of the master calls the new name, and falls back to the old one while a Mac's ks is older.
  - **Remote Control stays optional** (`ks-setup remote-control`, `ks.KS_REMOTE_CONTROL=1`); `claude-ks --rc` turns it on for one session.
  - **`ks-claude` is off PATH** (the launchers run it by path), and the retired `claude-ks-serena` is deleted. The shims of `ks-claude`, `claude-ks-rc`, `claude-ks-rc-restart` and `claude-ks-serena` are removed when the shims are next written (`ks-setup update` / `apply`).
  - **Sandbox excludes:** `claude-ks` (its `--dir` runs tmux), `claude-ks-start`, `claude-start` and `claude-ks-restart` replace `claude-ks-rc` and `claude-ks-rc-restart`; run `ks-setup claude-settings --yes` to add them (the doctor lists them as missing).

- **`claude-ks` is the command again** (no longer deprecated): it starts Claude for KarmaSuite through `scripts/ks-claude`, naming the session, turning on Remote Control when configured, and loading on-demand plugins. A plain `claude` still gets the plugins, rules and tokens, but not the following.
  - **Session names carry the device:** once 2+ Macs share the ks-flow board, sessions are named `<device label>:<unit>` (`B:KAR-123`, or `B:<folder>` with no workflow unit), so `ListAgents` shows which Mac each one runs on and `SendMessage` can address it. `ks-master` stays unprefixed. Labels (A, B, C…) live on each device's record in ks-flow (`devices/{id}.label`, ks-flow 0.4.0), are assigned by its daemon, editable in Settings → Devices, and listed by `ks-flow devices`.
  - **Remote Control by config:** `ks-setup remote-control` sets `ks.KS_REMOTE_CONTROL=1`, and `claude-ks` (every KS launcher) adds `--rc`. It replaces the `claude()` shell function, which a script can't see; `ks-setup remote-control --yes` removes the old function and `ks-setup doctor` warns while it remains (`remote-control:shell`).
  - **`ks-setup update` installs the new copy's CLI dependencies** (1.2.1): an installed ks ships without `node_modules`, and only a new session's SessionStart linked them, so after an automatic update the KS commands that need them failed (`ks-setup doctor`: "ks CLI dependencies missing") until a session started. The update now runs that step itself. 1.2.2: one command for it, `ks-setup deps`, which the update (the new copy's own), `ks-setup apply` and the doctor's fix all use; `ks-setup` is sandbox-excluded, so an agent runs it without the user (a plain `npm ci` in the plugin cache was blocked).
  - **The board's header shows the version it runs** (ks-flow 0.4.1): `ks-flow open` recorded the board's version (`.ks-flow-version`) only after a rebuild, and rebuilds only when a board file changed, so a release that didn't touch the board left the header on the old version. It now records it whenever the build matches the plugin's sources.
  - **A push reaches every Mac in a minute or two** (ks-flow 0.4.1): `meta/settings.releases` holds each KS plugin's newest pushed version, raised by the daemon running from a clone on a clean, pushed `main`; every daemon watches it live and runs its release check (then the update) as soon as it names a newer plugin. Before, only a ks-flow version bump spread at once and anything else waited for the hourly check. The check also runs at once when an installed version changed since the last one (a manual `ks-setup update`).
  - **Peers as a table:** the KS rules say how to list peers: one table grouped by device (`B · <device name>`), with the exact peer name to address. Each ks-flow daemon publishes its live session names (`devices/{id}.liveSessionNames`), so even an unprefixed session (plain `claude`, the master) is placed on its Mac; `ks-flow devices` reads a local cache (`<dataDir>/devices.json`, refreshed every minute, works offline; `--live` reads the store).

## 2026-11-15

- **One setup for a clone and for an install.** In the KarmaSuite checkout, `claude plugin install --scope local ks-suite@karmasuite` (per project: the switch is in that checkout's gitignored `.claude/settings.local.json`; `ks-setup apply` copies it into existing worktrees, `create-worktree` into new ones) + `/ks:setup`, or `plugins/ks/init-dev` (loads the clone as the `karmasuite` directory marketplace, read in place). Both end in the state `ks-setup doctor` checks. A plain `claude` — and the desktop app, IDEs — then gets the plugins, the KS rules (SessionStart context), a task list per worktree (`create-worktree` writes it into `.claude/settings.local.json`) and the tokens. `claude-ks` is deprecated (one release); the launchers run `scripts/ks-claude`.
  - **`ks-setup apply` only lists what is still missing** (the fixes of the doctor checks that fail). `ks-config` stores a secret with a read-back check, and `ks-config list` / `doctor` count an empty Keychain value as unset.
  - **Config per tool, tokens in the Keychain:** `ks-config list|get|set|secret|unset|import-legacy` (and `/ks:config`). Secrets: Keychain service `ks.<namespace>`; plain values: `~/.config/ks/<namespace>.env`. Lookup: env → store → the old `scripts/.env` / `.config`, which keep working until `ks-config import-legacy`. ks-flow reads tokens from the same store under its data `.env`, so they're set once.
  - **`ks-setup doctor|apply|claude-settings|store`** (and `/ks:setup`): tool checks, `~/.local/bin` shims with a PATH line in the right shell file, sandbox excludes, deny rules on the agent running `security` (the sandbox doesn't block the Keychain; `doctor` check `secrets:deny`), ks-flow's store. `init`, `init-dev` and ks-flow's `init` are thin wrappers.
  - **Plugins find each other by name:** `ks-root <plugin>` (`~/.config/ks/plugins.json`, recorded by each plugin's SessionStart, then `claude plugin list` `readFromFolder`). No more `../ks-flow` paths in the launchers or the daemon.
  - **Dependencies:** ks-flow → ks; ks-master → ks, ks-flow; ks-browser → ks. New `ks-suite` bundle (ks + ks-flow). ks-master and ks-browser are `defaultEnabled: false` and turned on per session by their launchers. **ks-agent-limit is disabled** (kept, not maintained).
  - **Installed copies work:** the ks SessionStart hook installs the CLI dependencies into `${CLAUDE_PLUGIN_DATA}/deps`; ks-flow's bootstrap falls back to `KS_PROJECT_ROOT_PATH`, checks `node`/`jq` and the Firestore key, never moves Claude's data dir, and copies sources without `node_modules`.
  - **`WorktreeCreate` hook:** `claude -w KAR-123` in the KarmaSuite checkout reuses the ticket's worktree or makes one with `create-worktree`; other names keep Claude's default layout. **`/ks:start-ticket`** and `ks-start-ticket --no-launch` prepare a ticket from inside a session.
  - The board's Remove defaults to `remove_worktree -D {{path}}` (no personal alias); the schema line in `state.yaml` points at the plugin's own schema.

## 2026-11-14

- **ks-flow's store moves to Firestore (GCP project `ks-flow`)**: the board, Briefing, Notes, Activity Log and backup index can now live in the `ks-flow` project's `(default)` database, the one ks-works uses for Slack tokens, instead of the local PocketBase. Its collections sit flat at the database root (`meta/project`, `workUnits`, `sessions`, `reminders`, …), with no per-project level: the GCP project holds one board.
  - **The browser never touches Firestore:** the board's own server reads it with the Admin SDK and streams it to the page (`/api/store/live`). So there is no Firebase sign-in, no browser API key and no rules deploy. Don't deploy `firestore.rules` there: it would replace ks-works' rules.
  - **Writes replace whole documents**, as PocketBase did. Notes with no due time, "clear due" and reminders with no note no longer fail, and a cleared field no longer comes back.
  - **One config file:** `$CLAUDE_PLUGIN_DATA/.env` (`DB_PROVIDER`, `FIRESTORE_MODE`, `FIREBASE_PROJECT_ID`, `FIRESTORE_CREDENTIALS`), read by the daemon, the board and `bootstrap.sh`. The private key is no longer copied into the launchd plist.
  - **`ks-flow migrate-store`** copies what the daemon can't rebuild (dry run unless `--write`): reminders and Notes, Briefing, master events, the backup index and runs, and Slack names.
  - **`ks-flow status`** shows which store is in use and whether it answers.
  - PocketBase stays available; going back is a config change.
- **ks-flow works offline**: with Firestore, a write that can't reach it (8 s, or a network error) waits in `<dataDir>/outbox/`, and the daemon syncs it once the Mac is back online. Several writes to the same document are combined into one, and a write Firestore refuses moves to `outbox/failed/`. While anything waits, new writes queue behind it, so an old write never overwrites a newer one. The board shows the last known state plus your unsynced changes, with an **offline · N changes waiting to sync** chip, and `ks-flow status` prints the count.
- **ks-flow: fewer Firestore writes and no stuck jobs.** The 3-minute Linear read no longer rewrites every live card just to stamp its time: the board's last Linear read is kept once on the project (`linearCheckedAt`), and a card is written only when its Linear values change. A restart rewrites only the cards that changed while the daemon was down. The daemon's Firestore reads give up after 15 s instead of hanging (seen at 15 min after the Mac woke). The board opens one live stream per tab, not three (a browser allows 6 connections per site, so two tabs left Notes stuck on "Loading…").
- **ks-master viewer opens alone**: `claude-ks-master` starts its Ghostty viewer with `--window-save-state=never`, so a Ghostty config that restores windows no longer opens blank windows beside it.

## 2026-11-13

- **`slack message send/reply/update --text-file <path>`** (`-` for stdin): post text with backticks. A backtick on the command line, even quoted, stops the sandbox from matching `slack` as excluded, so the call ran sandboxed and died with `listen EPERM` before posting; PR-review thread replies with inline code couldn't be sent. The text argument is now optional when `--text-file` is given. `/ks:slack` and the PR-review and release templates say to use it.
- **Quality hooks work from a subdirectory again**: `quality-files.sh` went back to the caller's directory after collecting the repo-relative file list, so a session whose cwd was a subdirectory (e.g. `apps/www`) matched no files and the format and lint hooks silently did nothing. It now stays at the repo root.

## 2026-11-04

- **Type checking is no longer a Stop hook**: `quality-typecheck.sh` ran tsc on every Stop and SubagentStop, which got too heavy. Format and lint still run as hooks. Agents now run the type check once per phase during verification (`/ks:implement-plan`, `/ks:build-prototype`), and the phase summary reports it as PASS/FAIL.
- **ks-docs is updated only after a release**: Phase 10 no longer writes to ks-docs right after the code review. Once the PR is ready, it tells you and waits (`docs: { status: "awaiting-release" }` on the iteration, Phase 10 still in progress) while you merge and deploy. When you say it's released, in that session or a later one through `/ks:project-manager`, it checks the PR is merged, then the writer works from the PR's diff (`gh pr diff`) and checks its claims against the released code on `origin/main`. Then Phase 10 is marked complete and the handoff is written. Agents never merge or deploy.

## 2026-11-02

- **ks-docs records known issues**: problems KarmaSuite has today that aren't fixed yet go in a `## Known issues` section of the concept they affect, one bullet each: what goes wrong, what a change there must not assume, and the Linear ticket. Phase 2 lists the ones in the areas it researches, Phase 9's plan says whether it works around, fixes or leaves each one, and Phase 10's writer adds problems the work found but didn't fix and removes the ones it fixed. `/ks-master:docs-review` checks each issue is current, in the right concept and linked to a ticket.
- **Every phase can look up ks-docs for business context**: the project-manager now tells every phase that KarmaSuite's product knowledge is in `~/git/ks-docs/content`, to use whenever it needs business context. Phase 1 (`/ks:user-context-generator`) looks up the features and terms you mention so it can ask sharper questions, and Phase 9 (`/ks:create_plan`) reads the concepts on the feature it plans and passes them to its research agents. Phase 2 already did. Agents read only the matching concepts, never the whole bundle.
- **`/ks-master:docs-review`: a strict check before you commit ks-docs**: ask the master session to "review the docs" and a subagent goes through every uncommitted change in `~/git/ks-docs/content`. For each file it checks:
  - **Format:** the knowledge-base format and house rules: frontmatter, sources cited, index and log lines, and no `verified` set by an agent.
  - **Scope:** whether it is product knowledge or code detail.
  - **Gotchas:** whether each one is reusable, recurring and not obvious from the code.
  - **Size:** whether it could be one line in an existing concept.

  You get a table with 1–5 scores and keep, trim or discard for each file, the trimmed text for each trim, and a recommendation. It only reports; you decide and commit. Its calibration examples start with the KAR-13414 gotcha you discarded and its one-line product version.
- **Phase 10's ks-docs writer is stricter in detail, wider in coverage**: when no concept covers the feature, page or flow a change touched, it writes that whole flow at product level, reading the untouched parts first and listing anything unconfirmed under `## Open questions`; when the flow is covered, it adds only what's new or wrong, usually nothing for a bug fix. `/ks-master:docs-review` doesn't mark a gap-filling concept down as over-scope, spot-checks its claims about the untouched parts, and scores it 5 on reusability and recurrence. It favours product knowledge (features, business rules, integrations, product decisions). It writes a gotcha only if the gotcha passes the three checks, and never writes code-level detail (function names, file paths, CSS values, commit pins). It prefers one line in an existing concept over a new file. Sources point to the ticket or PR, not to a pinned commit. The step's hand-off now suggests `/ks-master:docs-review`.

- **The workflow now reads and writes the KarmaSuite knowledge base (ks-docs)**: `~/git/ks-docs` is a shared knowledge base in the Open Knowledge Format.
  - **Phase 2 reads it:** `/ks:research_codebase` starts from the concepts that match the ticket and hands them to its research agents as leads. Every claim is still confirmed in the code, and concepts nobody has verified count as unchecked.
  - **Phase 10 writes to it:** `/ks:implement-plan` ends each iteration, after the code review, with an **Update ks-docs** step. A subagent follows ks-docs' own rules to fix concepts the change made false and to add durable knowledge (how something works, gotchas, decisions and their reasons). It writes nothing when there's nothing worth keeping, and nothing at all while ks-docs still has uncommitted changes from an earlier session: it lists them and asks you to review and commit them first. Changes are left uncommitted: you review them, mark what you checked as verified, and commit. It is a substep of Phase 10, not a new phase, so the board, the statusline and existing `state.yaml` files are unchanged.
  - **Recorded:** the outcome goes on Phase 10's iteration in `state.yaml` as `docs` (`updated`, `none-needed`, `skipped` or `unavailable`, with the files and a one-line note). The project manager runs the step before marking Phase 10 complete when a session ended without it.
- **`create-worktree` keeps `.claude/settings.local.json`**: new worktrees used to lose the main checkout's untracked `.claude` files, because the script ran `rm -rf .claude`. It now deletes only git-tracked `.claude` files (keeping `agents/test-writer.md`) and copies `settings.local.json` into the new worktree. That file grants write access to ks-docs.

## 2026-10-31

- **ks-flow Briefing: everything you owe, with a clock**: a new **Briefing** page lists the Slack messages that need you, each with a due time. The master session reads Slack at 00:00, 06:00, 12:00 and 18:00, or when you press **Brief me now**. It reads your DMs, your @mentions, your name written anywhere, and your own messages (to catch promises). Each item is an ask, a promise ("I'll do it by EOD") or FYI.
  - **Escalation:** an item goes calm, warm, hot, then overdue (full red) as its time runs out. You get one notice at hot, one at overdue, then a reminder at each scheduled run.
  - **Weekends:** something that arrives on a weekend starts its clock Monday 09:00.
  - **Your control:** you can change any due time; every change is kept, and pushing one later shows as "pushed N×". Only you archive (Done / Not mine / Won't do): replying doesn't close anything, and the master can only add "looks done" hints.
  - **One card per thread:** items from the same Slack thread share a card. Each keeps its own due time and its own Archive.
  - **Daily log:** a **Daily log** page shows what `/ks-master:log-off` recorded: what you archived, what slipped, promises due tomorrow, where each session stopped, and engaged time.
  - **Off until you turn it on:** `/settings` → **Briefing**. That section also sets the run times, the names to watch for and a half-time sender list.
- **ks-master plugin: one always-reachable master session**: `claude-ks-master` starts it in the main checkout, always in its own tmux session `ks-master` (`tmux attach -t ks-master` to watch it), with Remote Control on. It carries the skills `/ks-master:briefing`, `/ks-master:log-in`, `/ks-master:log-off` and `/ks-master:restart`, which only this session loads.
  - **Waking it:** the ks-flow daemon and the board leave request files that the master's mod submits as turns when it's idle. Nothing blocks the session.
  - **Restarting it:** `claude-ks-rc-restart --master` restarts it in place. It restarts itself, with a handoff, after log-off or past 70% context. The daemon starts it when it's down, and force-restarts it when a request goes unanswered for 15 minutes with no heartbeat.
  - **Sandbox:** in the master's project, `ks-flow`, `ks-time`, `claude-ks-rc-restart` and `claude-ks-master` must be excluded first-word commands.
- **ks-flow Activity Log replaces the Backups page**: the tab is now **Activity Log** (`/activity`; `/backups` redirects there), one history of everything ks-flow and the master session do in the background, newest first, each row with a type and filter chips to narrow it.
  - **Backup:** every transcript backup sweep, with everything the Backups page showed (trigger, status, sizes, the list of uploads, See logs for a running one).
  - **Briefing:** each pass of the master over Slack (Scheduled 06:00, Brief me, by hand): items added and updated, where Slack was read up to, the master's summary or the error.
  - **Log-in / Log-off:** the master's start- and end-of-day runs, each linking to that day's Daily log.
  - **Master:** the daemon starting or force-restarting the master (why, and whether the command succeeded), and every request sent to it (scheduled, Brief me now, Restart master), including ones dropped because one was already waiting. These are kept in a new store collection, `master_events`.
- **ks-flow: one header on every page**: tabs (Board, Briefing, Daily log, Notes, Activity Log), the Briefing bell, an **Inbox** button that opens the Plannotator Inbox with a count of what's waiting, and the master's status. Each page's own controls sit in a row under it.
- **ks-flow Settings no longer drops other settings on save**: saving the Settings page used to rewrite `board-settings.json` with only the parts that page edits, deleting the transcript-backup settings the daemon reads. Saves now keep every other part of the file.
- **ks-flow's Inbox guard is removed**: the `PreToolUse` hook (`scripts/inbox-guard.mjs`) that refused an Inbox send naming another checkout never ran for the tool sessions actually use. Plannotator's in-process `plannotator_inbox` tool is answered by its mod without passing the call on, so Claude Code never reaches the step where plugin `PreToolUse` hooks run: a log line at the top of the script never ran, even after `/reload-plugins`. The hook, the script and its tests are gone. The ks-flow README ("No guard on Inbox calls") records why, and what a working guard would need.
- **Quality hooks run only in your project**: the format, lint and typecheck Stop hooks now run only in the repo set as `KS_PROJECT_ROOT_PATH` in `plugins/ks/.config` (by `./init`) and its worktrees. Everywhere else they exit without checking. Before, they ran in every repo a `claude-ks` session worked in, and in this plugin repo they failed on every stop with `Command "eslint" not found`, since it has no JS toolchain for them. The code-simplifier suggestion follows the same gate.
- **ks-flow: Done is a board column**: finished tickets now move to a **Done** column, the last column of their lane, as ordinary cards. They used to drop into two tables below the board ("Completed worktrees · not removed" and, behind **show completed**, "Completed · worktree removed"). Those tables showed no Inbox state, so a question from a Done ticket's session reached you only in the Inbox and as a notice. Done cards now show the **NEEDS YOU** sash, thread rows, backup/restore, reminders and Remove like any other card. **show removed** (formerly **show completed**) adds Done work whose worktree is gone, dimmed and Restore-only. The daemon keeps reading Done tickets from Linear while their worktree exists, so reopening one moves its card back to its phase column. Before, a Done ticket stopped being polled.
- **ks-flow shows the Plannotator Inbox on each card**: when an agent asks in the Inbox instead of the terminal, its card now says so. Before, a session waiting there looked idle in its tmux pane and on the board, and KAR-13197's two blocking questions went unseen for hours.
  - A diagonal **NEEDS YOU** sash goes across the card's top-right corner, red when the agent stopped until you answer. Clicking it opens the thread.
  - Each card gets one row per Inbox thread (`⛔ Stopped on you · 2 open questions · holds up: …`, `Inbox ↗`). A thread with only new messages gets a quiet `✉ 1 new message` row and no sash.
  - The card shows `⏳ waiting: Inbox`, and a macOS notice goes out when a new question arrives.
  - How it works: the daemon reads the Inbox's files read-only on its 15s clock (`src/lib/inbox.ts`), following the Inbox's own rules for when a question is open or answered. It never reads the Inbox token. The daemon now has tests (`cd plugins/ks-flow/src && npm test`).
- **Inbox threads join cards by session id only, with a guard on sends**: a card shows only questions and messages its own Claude sessions wrote. A message's sent-from folder (`base_path`) is ignored, and another session replying into the card's thread doesn't add its question to the card. A new `PreToolUse` hook (`scripts/inbox-guard.mjs`) refuses an Inbox `send_message` or `submit_guide` whose `project_path` is outside the session's own git checkout. It's a guard rail, not a lock: it only runs in sessions that load ks-flow, and the Inbox's stdio server and HTTP API accept any session id.

## 2026-10-30

- **PR previews come back after a dropped connection**: the `/ks-project` pane's Vercel pills (`▲ DEPLOYING`, `▲ PREVIEW`) no longer vanish for the rest of a session after one failed Vercel call. Any error other than an auth refusal (the MCP server still connecting at startup, reconnecting after sleep) was read as "vercel plugin not installed": the pane stopped asking and dropped the pills, leaving only the GitHub link until the session restarted. Now a failed call keeps the last preview shown and asks again at the 2-minute idle interval.
- **PR previews when the project has its own Vercel server**: the karmasuite project registers Vercel's MCP server itself, as `vercel` (same URL as the vercel plugin's). The session then keeps only that one, and the pane, which asked only for `plugin:vercel:vercel`, got "no connected MCP tool" on every call and showed no previews. The pane now tries both names and keeps using the one that answers. When previews can't be fetched, the session shows one line with the reason (`ks: PR previews unavailable, retrying every 2 min: …`), once for each new reason. An unreadable answer from Vercel now counts as a failure too; before, the pane showed nothing and gave no reason.
- **`quit-chrome` and `mem-info`**: two macOS helpers in `scripts/` for things the Bash sandbox blocks. `quit-chrome` quits Chrome cleanly and checks that it exited. `mem-info [N]` shows memory pressure, a usage breakdown as Activity Monitor counts it, swap, and the top processes by memory. An agent can run them only when they're in `excludedCommands` (see `scripts/README.md`, "Machine helpers").

## 2026-10-22

- **Agents start the next session themselves**: when you ask for a new session, or a phase boundary calls for one (`/ks:project-manager` after phases 1, 2 in a ticket workflow, 8 and 9), the agent offers to switch over. It runs `claude-ks-rc-restart --dry-run`, then the restart. The fresh session opens in the same tmux pane with the project-manager prompt and Remote Control on. Before, the agent said it couldn't start a session and handed you the `claude-ks` command: the phase-boundary text told it to, and the `ks-rules.md` section only covered Remote Control requests. The manual command remains the fallback when the dry run fails.
- **Linear — cycle moves always go through `bulk-update`**: `/ks:linear` rule 6 no longer reads as permission to loop `update --cycle` when the order matters. Move the issues with one `bulk-update`, then set their order per issue (`--position first`, then each `--after` the one before). If you haven't said where they go, the agent asks. Before, a session moved 4 tickets with 4 `update --cycle next --position last` calls and put them at the bottom, where you wanted them at the top.

## 2026-10-20

- **Relaunch a session with Remote Control**: `scripts/claude-ks-rc <dir>` starts `claude-ks --remote-control` in a directory: in a given tmux pane, a new tmux window, or this terminal. `scripts/claude-ks-rc-restart [<ticket>]` lets an agent swap its session for one with Remote Control on. It gets the ticket's live session (pid, tmux pane) from ks-flow, checks the pid with `ps`, kills the session from inside the tmux server, and starts a fresh session in the same pane. Its first message is the project-manager prompt, which picks up from the latest handoff. Both need `excludedCommands` entries to run from a sandboxed agent.
- **ks-flow knows each card's live session**: the daemon matches Claude's `~/.claude/sessions/<pid>.json` to cards by cwd and stores `liveSessions` / `activeSession` (pid, session id, tmux pane) on the work unit. A pid counts only while alive with its recorded start time. `ks-flow session <unit> --json` reads it back.

## 2026-10-19

- **Slack CLI — `--no-unfurl`** on `message send` and `message reply` posts without link or media previews (`unfurl_links`/`unfurl_media: false`). Fixed at send: Slack can't turn a preview on later. Refused with `--file`, whose upload API takes no unfurl flags.
- **PR review requests post without previews**: the `pr-review-request` template now sends with `--no-unfurl` unless you ask for previews. A message with files can't skip previews, so the agent says so and sends with previews on your confirmation.
- **PR review requests post in two parts**, like release announcements: the main message (title, PR link, project thread) in #engineering, then the `Changes:` bullets as a reply in its thread. Each part is shown for confirmation before posting; `review_thread` records the main message.
- **`ks-start-ticket` restores before it writes**: with ks-flow's cloud backup on, the restore offer now runs before `state.yaml` is read or written. Restore only fills in missing files, so the fresh `state.yaml` the script wrote first used to shadow the backed-up one on a machine without the ticket's folder: its phases, PRs and `time_spent` were dropped, and the next backup uploaded the fresh file over them. One `Restore?` question still covers both; the workflow folder comes back first (new `ks-flow restore --workflow-only --workflow-dir`), the sessions and time log once the worktree exists.
- **Linear — agents reach for the bulk commands**: `/ks:linear`'s workflow rules now say to use one `issue bulk-update` call when several issues get the same `--cycle`, `--state`, `--assignee` or `--priority`: `--dry-run` first, at most 50 issues, one team for `--cycle`/`--state`. Use per-issue `update` only when the manual order has to change, since `bulk-update` sends no `sortOrder`. To read many issues, use `issue batch-get`. Before, the rules pointed only to `issue update`, so a 46-ticket cycle move ran one ticket at a time. `issue update --help` now points to `bulk-update` too.

## 2026-10-15

- **Linear CLI — `project edit --content-file` / `--description-file`** (`-` = stdin), so a project description with quotes or backticks no longer goes inline. `/ks:add-product-requirements` now publishes `prd.md` this way.
- **Relative paths resolve from your directory**: the `linear`, `slack` and `grain` wrappers `cd` into `scripts/`, so a relative `--content-file`, `-f` or `-o` used to resolve there (ENOENT, or `grain` output landing in `scripts/`). They now pass `KS_ORIGINAL_DIR` and each CLI changes back to it on startup.
- **`document update --json`** returns the updated title (and now the `url`); it used to report the document as read before the update.

## 2026-10-14

- **Session name at launch**: `claude-ks` now starts a workflow checkout's session with `--name KAR-123` (or the project's workflow folder), from `scripts/session-title.sh --print`. The `SessionStart` hook's `sessionTitle` only reached the transcript: the peer name `ListAgents` prints and `SendMessage` takes is fixed at startup, so a new session answered to its derived `<folder>-<xx>` name until resumed. Skipped when you pass `--name`, `--resume` or `--continue` (a resumed session keeps its saved name). Only the name changes; the session ID is untouched.

## 2026-10-08

- **statusline — Linear link**: in a ks workflow checkout the statusline shows the ticket id (or `project`) as a clickable link to Linear, read from the `state.yaml` whose `worktree_dir` is the checkout.
- **Session name**: a `SessionStart` hook names the session after the checkout's ticket (`KAR-123`), or the project's workflow folder, so it can be messaged by that name (`SendMessage`). The workflow lookup moved to `scripts/workflow-unit`, shared with the statusline.
- **Project pane**: `/ks-project` (or the statusline's `≡ more`) opens a pane with the checkout's whole workflow state: ticket and Linear details, phases with times, every Slack thread, PRs with their review threads, and the worktree and workflow folder.
- **Split statusline**: in `claude-ks` sessions `scripts/statusline` draws the static half (session name, context, branch) and the ks plugin draws the interactive half in the prompt's hint line (`hooks/register.tsx`): the checkout's ticket as a clickable pill, its current phase and a status pill, `≡ more`, and the rate limits. `scripts/statusline` stops after its half when `KS_MOD_STATUSLINE` is set and keeps its full output in plain `claude` sessions.

## 2026-10-01

- **Linear CLI — cycles and manual order**:
  - `issue list --cycle current|next|previous|<number>|<id>` filters by cycle.
  - `issue list --sort manual|created|updated`. `manual` is the user's drag-and-drop order (`Issue.sortOrder`).
  - `issue create|update --cycle` moves an issue into a cycle. `update` also accepts `none`.
  - `issue create|update --position first|last`, `--after <id>` and `--before <id>` set the issue's manual order.
  - `issue get` shows the issue's cycle.
- **Linear CLI — relations**:
  - `issue relate <id> <others...> --type related|blocks|blocked-by|duplicate` links issues.
  - `issue unrelate <id> <others...>` removes the links.
  - `issue create --related <ids...>` links the new issue when it is created.
  - `issue get` always lists relations.
- **Linear CLI — `--description-file <path|->`** on `issue create|update` keeps markdown with backticks off the command line. Inline backticks make the command miss the sandbox exclusion.
- **gh-cli — stacked pull requests**:
  - New `gh stack` reference covering setup, create, view, rebase/sync, restructure, merge, exit codes and CI metadata.
  - GraphQL `stackEntry` query for a PR's stack membership.
  - Warning that `gh pr merge` cannot merge stacked PRs.
  - Notes that `--base <branch>` alone is not a native stack, and how to split a PR into a code PR and a stacked tests PR.
- **create_pr — native stacks**: when the target branch has an open PR, the new PR is linked onto it with `gh stack link`. If the extension is missing, the user is asked before it is installed.
- **prd-to-linear-tickets**: creates tickets with `--description-file` and `--estimate`, and links dependent Features with `issue relate --type blocks`.

## 2026-04-01

- **Statusline script**: Custom statusline showing context window usage, git branch, and rate limit info (5h/7d windows with color-coded usage and reset countdowns). Wraps to two lines when branch name exceeds 32 characters.
- **Statusline**: Use muted red (`167`) instead of bright red (`196`) for high-usage color — easier on dark terminals
- **Hooks**: Removed code-simplifier suggestion hook from Stop and SubagentStop events (command still available manually)

## 2026-03-31 – 2026-04-01

- Neon branch protection hook
- Code-simplifier suggestion hook on Stop and SubagentStop events
- Slack CLI: shared lib, template frontmatter fields, raw template view
- Slack templates: tone field, updated LOOM_URL guidance; conditionally omit demo line when no Loom URL
- Rules: dynamic schema path, enforce template channel, DB views migration guidance
- create-worktree: preserve test-writer agent on cleanup
- Attachment CRUD and `--status` alias for Linear CLI
- Research agent model upgrade from Sonnet to Opus
- Extract shared lib modules from TS scripts
- Rename state.schema.json to project-state.schema.json

### Changes to workflow
- Linear tickets added as input to phases 9 and 10
- Feature flags mandated for project workflows (phases 3, 7, 9)
- Per-phase PRs for project workflows in Phase 10
- TAD and codebase research added as inputs to Phase 8
- user-context.md added as input to all workflow phases 3–9
- Inline phase files into project-manager.md, replace `KS_PHASE_FILES_DIR` with `KS_PLUGIN_DIR`

## 2026-03-16

### Features
- **remove_worktree** now safely preserves workflow data before removing a worktree:
  - Restores `.claude/` to clean state, then checks for uncommitted/untracked changes — aborts if dirty
  - Finds the matching `state.yaml` by `worktree_dir` and copies the workflow folder back to the main repo before removal
  - Aborts if no matching `state.yaml` is found, preventing workflow data loss
  - Must be run from `KS_PROJECT_ROOT_PATH`

### Other
- Architect command improvements (consumer impact analysis, no-duplicated-logic rules)
- `worktree_dir` field added to state schemas
- `KS_` prefix for `.config` vars with dotenv loading in all TS scripts
- Quality-files path fix

## 2026-03-13

### Features
- **Phase 9-10 iteration cycles**: Planning and implementation now support multiple iteration cycles. Each cycle produces a numbered implementation plan (`implementation-plan-01.md`, `-02.md`, etc.) tracked in `state.yaml` — enabling incremental delivery where each plan-implement cycle builds on the previous one. Added phase revisit mechanism with `REVISITING`/`INVALIDATED` states for when earlier decisions need to change.
- **Persistent task lists across sessions**: Task lists are now tied to the current git branch, so tasks persist across Claude Code sessions. Resuming work on a branch picks up where you left off.
- **Eval sets for all agents and commands**: Added `eval-set.json` files for every agent and command. These define structured test scenarios with inputs, expected behaviors, and scoring criteria — enabling automated evaluation and regression catching when updating prompts.

### Other
- Linear CLI: issue attachments command, `--full` includes attachments, fixed `--priority` type coercion
- Quality scripts: stderr output, exit code 2 for failures, typecheck filtering for changed files only
- Simplified Serena instructions across all agents; centralized KarmaSuite conventions in `ks-rules.md`
- Updated all command docs with ticket workflow support, orchestrator pattern, and stronger Phase 9 boundaries

## 2026-02-27

### Features
- **Multi-plugin monorepo restructure**: All plugin content now lives under `plugins/ks/`, enabling future plugins under `plugins/<name>/`
- **`--plugin` flag**: Enable plugins per session instead of managing them globally using `/plugin`
- **Automated Linear project updates** in phases 3, 5, 6, 7 using Linear project update CLI instead of manual prompts
- **Project manager auto-resume**: Now reads the latest handoff file automatically when resuming a project
- **Slack CLI**: Added `slack template list` and `slack template view` commands with template-first messaging workflow
- **Release announcement template** and channel IDs added to Slack templates
- **Research codebase** command now auto-reads Phase 1 user context instead of asking user to re-explain

### Improvements
- Simplified all 10 phase files — separated execution steps from post-completion steps into a consistent pattern
- Quality format/lint scripts now re-check after auto-fix to catch unfixable issues (parse errors, lint violations)
- Enforced Serena MCP as primary tool for all research agents with decision tree and NEVER rules for Grep symbol lookups
- Split README into monorepo-level and plugin-level docs

## 2026-02-18

### Initial Release
- **KS plugin for Claude Code**: Project and task management workflow orchestrator, installable as a plugin (disable anytime — except manually copied rules)
- **Scripts**: `create_worktree`, `remove_worktree`, `ks-start-ticket`, `ks-start-project`
- **Linear CLI**: Interact with Linear from the command line
- **Hooks**: Automated formatting, linting, and type checking
- **`ks-rules.md`**: Optional KarmaSuite coding conventions
- **Docs**: `README.md` (development setup), `WORKFLOW.md` (workflow understanding and usage)
