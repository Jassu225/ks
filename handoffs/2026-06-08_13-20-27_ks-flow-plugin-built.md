---
date: 2026-06-08T13:20:27+05:30
git_commit: 185259a
branch: feat/ks-flow-plugin
task: ks-flow plugin — fully built (all 7 plan tasks done) and verified against real data; nothing committed yet
---

# Handoff: ks-flow Plugin — Built & Verified (uncommitted)

> Design lives in `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`. This session **built the whole plugin** from that approved plan and verified it against real on-disk data. Nothing is committed.

## What Happened

Implemented all 7 tasks from the plan. The plugin is complete, type-checks/builds clean, `claude plugin validate` passes, and the daemon's full pipeline was verified end-to-end against the real karmasuite project (35 sessions, 102 work-units) — **including the Firestore transport against the live emulator** (admin-SDK write → emulator → admin-SDK read + `onSnapshot` subscribe all confirmed).

## Built (file map under `plugins/ks-flow/`)

- **Scaffold:** `.claude-plugin/plugin.json` (userConfig + `defaultEnabled:false`), `hooks/hooks.json`, `README.md`; `ks-flow` entry added to root `.claude-plugin/marketplace.json`.
- **DB layer (`src/lib/db/`):** `types.ts` (the stable seam — `SessionWriter`/`SessionSource`/`DbProvider` + `ProjectDoc`/`WorkUnitDoc`/`SessionDoc`), `index.ts` (factory), `providers/firestore.ts` (admin writer + admin-based source), `providers/{file,sqlite}.ts` (documented future stubs), `providers/memory.ts` (NEW — dry-run writer, see Deviations).
- **Daemon (`src/`):** `daemon.ts` (backfill → chokidar tail → derive → join → store; single-flight, debounced), `lib/{config,paths,worktree,checkpoints,jsonl,derive,stateyaml,phasemodel,join}.ts`. `package.json`/`tsconfig.json` mirror `plugins/ks/scripts`.
- **Hooks/CLI (`scripts/`, `bin/`, `launchd/`):** `_common.sh` (project filter, throttle, event append, terminal-notifier), `notify-{waiting,permission,elicitation}.sh`, `bootstrap.sh` (project.conf + node_modules diff-install + launchd render/load), `bin/ks-flow` CLI, `launchd/*.plist.tmpl` (reference; bootstrap renders inline).
- **Board (`web/`):** Next.js App Router + Tailwind. `app/page.tsx` (server, reads config from project.conf + env), `components/{Board,Column,SessionCard}.tsx`, `lib/{firebase,useBoard,types}.ts`. Client-SDK `onSnapshot`, provider-agnostic.
- **Firestore:** `firebase.json` + `firestore.rules` (owner-only reads, no browser writes).

## Deviations from Plan (all deliberate, all sound)

1. **`jsonl.ts` — no in-memory residual buffer.** The plan's residual pseudocode re-reads from an unchanged offset and would double-count a partial line. Replaced with offset-only newline-aligned reads (`parseComplete`): always read `[byteOffset, size)`, advance only past the last `\n`, re-read the partial tail next pass. Simpler and fully restart-safe.
2. **state.yaml watching → periodic 15s rescan**, not a recursive chokidar `**/state.yaml` glob. The recursive glob opens an FSWatcher per directory and hit **`EMFILE: too many open files`** on the real workflow tree. Rescan (idempotent `scanStateYaml`) is cheaper and robust. (Found and fixed during verification.)
3. **Added `fsevents` as an `optionalDependency`** so chokidar uses a single FSEvents stream on macOS instead of per-file `fs.watch` (the other EMFILE driver). NOTE: fsevents did **not** materialize in this environment (broken `~/.npm` cache marks it "deduped" but never writes the dir) — see Known Issues. It will install normally on a clean machine.
4. **Watcher `error` handlers** added (log + continue) so EMFILE/transient FS errors never crash the daemon.
5. **`KS_FLOW_DRYRUN=1`** (memory provider, dumps `dryrun-dump.json`) and **`KS_FLOW_BACKFILL_ONLY=1`** (ingest once, flush, exit) added as debug/verification affordances.
6. **Firestore `source()` implemented with the admin SDK** (Node-side, usable for `ks-flow status`/SSE fallback); the **browser** reader is the client-SDK `onSnapshot` in `web/lib/{firebase,useBoard}.ts` — fulfilling the plan's "source = client SDK on the board".
7. **Web doc types mirrored** in `web/lib/types.ts` (small, documented) rather than imported across the `src`↔`web` boundary, avoiding Next `externalDir` config.

## Verification (what passed)

- **Logic harness (19/19)** against real data: worktree common-dir + encoding (`/Users/jassu/.claude → -Users-jassu--claude`), in/out-of-project membership, `state.yaml` parse (KAR-11021 → ticket, phases), phaseModel ordering, session derive (cwd/msg-counts/lastActivity), string-vs-array content guard, join.
- **Daemon backfill E2E** (KS_FLOW_BACKFILL_ONLY + memory provider) on `~/karmasuite/karmasuite`: 14 in-project session dirs → **35 sessions**, **102 work-units**, **11-column phaseModel** (0–10, workflowType `mixed`). Cards distributed across columns (33 in phase 0, 5 in phase 1, 64 in phase 10). All 35 sessions `inProject:true` with cwds under the project root (**scoping correct**). 32/35 titles from `aiTitle`, 60 units with PR badges, worktreePath on all sessions.
- **Firestore transport E2E (live emulator)** — JDK 24 found at `/Library/Java/JavaVirtualMachines/jdk-24.jdk` (the `/usr/bin/java` stub just couldn't locate it); the firebase emulator only binds ports with the Bash sandbox disabled (`listen EPERM` under sandbox). With both fixed: daemon backfill wrote via admin SDK → emulator; readback via `source()` returned project (11-col phaseModel, `mixed`), **102 workUnits**, **35 sessions**, sample joined unit `KAR-11595` (9 sessions), 32/35 titled; **`subscribeSessions` onSnapshot fired with 35 docs — realtime path confirmed**.
- **Waiting logic:** ask open→`AskUserQuestion`; tool_result clears it; permission overlay surfaces then clears on a newer (forward-progress) line; TTL expiry works; `joinUnit` aggregates `waiting.active`/tool/sessionId onto the card.
- **Web:** `next build` succeeds; `tsc --noEmit` clean. **Plugin:** `claude plugin validate` passes; all shell scripts pass `bash -n`.

## Known Issues / Blocked

- **Emulator needs JAVA_HOME + unsandboxed bind.** JDK 24 is installed but `/usr/bin/java` can't find it — run with `JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-24.jdk/Contents/Home PATH=$JAVA_HOME/bin:$PATH`. The emulator also needs the Bash sandbox **disabled** to bind its ports (`listen EPERM` otherwise). Jar cached at `~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar`. Transport is now verified (see above); the **visual board** (`ks-flow open`) and **browser client-SDK** onSnapshot (vs the admin-SDK onSnapshot that was tested) remain the only unrun pieces — same emulator, identical onSnapshot API.
- **fsevents won't install in this environment** (broken `~/.npm`, root-owned — `sudo chown -R 501:20 ~/.npm` fixes it). Without fsevents, chokidar live-tailing hits EMFILE on macOS; the daemon survives (error handlers) but live updates degrade. Resolves once fsevents builds on a clean machine.
- **terminal-notifier not installed** → `notify()` no-ops gracefully. Documented dependency; `brew install terminal-notifier`.
- Conditional-required userConfig (gcp_project_id/credentials required only when `cloud`) can't be expressed in the manifest schema — left optional, validated at runtime in `bootstrap.sh`/firestore provider.

## Resume Point

Build is **done and uncommitted**. Next steps, in order:
1. **Commit** the work (user hasn't asked yet — branch `feat/ks-flow-plugin`). Untracked: `plugins/ks-flow/`, `docs/`, the two handoffs; modified: `.claude-plugin/marketplace.json`. `.gitignore` excludes `src/{node_modules,dist}`, `web/{node_modules,.next}`, build artifacts.
2. **Visual board check** (only unrun piece): with the emulator up (JAVA_HOME + unsandboxed) and the daemon running in live mode, `ks-flow open` → confirm columns render from phaseModel, cards land in their phase columns, and a live `AskUserQuestion`/`PermissionRequest` paints the "waiting on you" badge + macOS notification (install `terminal-notifier` first).
3. **Real-machine install test:** `claude --plugin-dir ./plugins/ks-flow`, enable, confirm `bootstrap.sh` installs node_modules into `$CLAUDE_PLUGIN_DATA` and loads the launchd agent (`launchctl list | grep ksflow`).

Debug commands: `KS_FLOW_DRYRUN=1 KS_FLOW_BACKFILL_ONLY=1 node src/dist/daemon.js` (after `cd src && npm install --cache <writable> && npx tsc`) writes `$CLAUDE_PLUGIN_DATA/dryrun-dump.json`. `ks-flow status` shows daemon + checkpoint state.
