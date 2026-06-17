---
date: 2026-06-17T23:27:18+05:30
git_commit: c89f151
branch: feat/ks-flow-plugin
task: ks-flow data-dir made load-method independent (single-source datadir.mjs + migration + bin auto-discovery + board diagnostic); ks KS_EXTRA_PLUGINS modular plugin loading; GCS archive bug fix + flat object path + env-aware bucket; unified ks phase-end commands. Plus the two PRIOR uncommitted features (GCS archive + reminders) finally committed this session. About to commit (multiple) + push.
---

# Handoff: ks-flow data-dir fix + extra-plugins + archive path/bucket + phase-cmd unify

> Builds on `2026-06-17_18-38-02_ks-flow-gcs-archive-and-reminders.md` (which left two features uncommitted + the data-dir split-brain bug as the resume point). All of that is now resolved and committed here. Plugin docs: `plugins/ks-flow/README.md`. Approved plan for the data-dir fix: `~/.claude/plans/quizzical-humming-sunrise.md`.

## What Happened

Six bodies of work this session (all typecheck-clean: daemon `npx tsc --noEmit` in `src/`, board in `web/`; bash `bash -n` + behavior-tested):

1. **Data-dir made load-method independent (the open bug — FIXED).** `CLAUDE_PLUGIN_DATA`'s `<plugin>-<marketplace>` suffix caused inline (`ks-flow-inline`) vs marketplace (`ks-flow-karmasuite`) to resolve different dirs → hooks wrote where the daemon wasn't reading → reminders never fired in dev. New scheme derives the dir from the project's **git-common-dir**: `~/.claude/plugins/data/ks-flow/<encoded-common-dir>/`. Precedence everywhere: `KS_FLOW_DATA` → derived → `CLAUDE_PLUGIN_DATA` (legacy fallback) → old default.
   - **Single source of truth: `src/lib/datadir.mjs`** (new; zero-dep plain ESM, NO build needed). Exports `encodeCommonDir`/`dataDirForCommonDir`/`gitCommonDir`/`resolveDataDir`, plus a CLI (`node datadir.mjs --cwd|--project <path>`). Bash entities (`_common.sh`, `bootstrap.sh`, `bin/ks-flow`) shell to the CLI; the daemon (`config.ts`) imports it; web reading sites honor `KS_FLOW_DATA`; `web/app/api/project` shells to the CLI. tsconfig got `allowJs` + `lib/**/*.mjs` so tsc emits `dist/lib/datadir.mjs`.
   - **One-time migration** in `bootstrap.sh`: if the derived dir is absent, `mv` the richest legacy dir (has `daemon/dist` or `pocketbase/pb_data`) into place. **Already RAN live** — `ks-flow-karmasuite` → `ks-flow/-Users-jassu-karmasuite-karmasuite--git`; 78 tracked sessions + pb_data preserved.
   - Hooks (`_common.sh`) restructured: `init_data_dir <cwd>` resolves DATA_DIR lazily after `read_payload`; called by all 5 notify hooks + session-end.

2. **`bin/ks-flow` auto-discovery + board diagnostic.** `bin/ks-flow` now resolves the data dir run-from-anywhere: KS_FLOW_DATA/project-env → cwd-in-a-configured-project → **exactly one configured project anywhere → use it** → else cwd (+warn if ambiguous). The board's "No project configured" screen now prints **which data dir it's reading** + says to relaunch with `ks-flow open` (`web/app/page.tsx`, `web/lib/types.ts` `BoardConfig.dataDir`).

3. **`KS_EXTRA_PLUGINS` — modular extra-plugin loading (ks plugin).** `claude-ks` now loads space-separated local plugins from `KS_EXTRA_PLUGINS` (in `plugins/ks/scripts/.env`) as `--plugin-dir plugins/<name>`. `plugins/ks-flow/init` self-registers `ks-flow` into that var (idempotent, non-destructive — sibling-temp + `mv`). So `claude-ks` / `claude-ks-serena` load ks-flow alongside ks, and the phase-end launch commands pick it up. Docs: `plugins/ks/scripts/README.md`, root `README.md`, `CLAUDE.md`.

4. **GCS archive bug fix + path simplification + env-aware bucket.**
   - **Bug FIXED**: `tar -cf - -C parent <base>` failed (`tar: Invalid replacement flag`) because encoded transcript dir names start with `-` (tar parsed them as flags). Fix: `--` end-of-options before the operand (`archive-core.ts:131`). Every transcript archive was broken before this.
   - **Object path flattened** per user: removed BOTH `<projectId>` and `<ts>` → now `gs://<bucket>/<prefix>/<identifier>/{transcript,workflow}.tar.zst`. `objectPrefix == dedupPrefix` now → re-archiving an identifier OVERWRITES (no history). Removed dead `tsSlug` export. (`archive.ts`, `backfill-archive.ts`, `archive-core.ts`.)
   - **Env-aware bucket UI**: `GET /api/settings` returns `gcsBucketEnv`; the Settings page shows the Bucket field read-only ("set via GCS_BUCKET env") when env provides it. (`api/settings/route.ts`, `settings/page.tsx`.)
   - Confirmed the invariant: remove command runs ONLY after a successful GCS upload when archiving is enabled (`run-command/route.ts:144-169`).

5. **Unified ks phase-end next-session commands** (`plugins/ks/commands/project-manager.md`). All four now use `cd {cwd} && claude-ks-serena "/ks:project-manager Let's work on ./{project-directory-path}/ project"`; only 9→10 adds `--plugin code-review@claude-plugins-official`. (Phase 1→2 was the odd bare one.)

6. **Committed the two PRIOR features** from the last handoff (GCS archive-on-removal + backfill; session reminders) — they were typecheck-clean + daemon-deployed but uncommitted.

Daemon redeployed several times via `ks-flow start` (last pid 79250); migration + all rebuilds applied.

## Key Decisions Made
- Data-dir keyed on **git-common-dir** (readable encoded form, not the sha256 projectId) — user's choice.
- **One canonical `datadir.mjs`** as a node CLI is the durable pattern for sharing logic across bash + two TS packages (no drift); future entities call it.
- `KS_EXTRA_PLUGINS` lives in the **ks** plugin's `.env` (the file `claude-ks` already sources); ks-flow `init` writes into it.
- Archive object path flattened to `<prefix>/<identifier>/` (no projectId, no timestamp) — accepts overwrite-on-rearchive + cross-project collision risk if one bucket+prefix is shared (mitigate with distinct `prefix`).
- PocketBase stores only `archived: boolean` — no GCS path — so moving objects in storage needs no DB fix.

## Deviations from Plan
- The approved data-dir plan didn't include `bin/ks-flow` auto-discovery or the board diagnostic; both were added after a live blank-board incident (stale pre-migration board pointing at the moved-away legacy dir).

## Uncommitted Changes
Everything in `git status` (about to be committed in this session). New: `src/lib/datadir.mjs`, the prior features' files (archive*, reminders, `serverdb.ts`, web routes, pb migration, notify-stop/session-end), and this handoff. Modified: docs, bash, daemon, db, web. (`plugins/ks/scripts/.env.example: Operation not permitted` in status = sandbox read-deny on a gitignored file, not a change. `src/dist/`, `node_modules`, `.next` are gitignored.)

## Known Issues
- GCS archive **untested against a real bucket** — needs `GCS_BUCKET` + creds in the data-dir `.env` (`/Users/jassu/.claude/plugins/data/ks-flow/-Users-jassu-karmasuite-karmasuite--git/.env`) and `zstd` installed. The tar/path bugs are fixed; the upload leg itself is unverified end-to-end. The user was setting up a GCP service-account.
- Full reminders e2e (real Stop in a live karmasuite session → banner → 5-min repeats) — mechanical pieces verified; not watched end-to-end.
- `ks-flow-inline/` empty leftover dir exists — harmless, can `rm -rf`.
- The board server may need a relaunch (`ks-flow open`) to pick up the web changes (data dir message, bucket-env field).

## Resume Point
1. Commit + push are being done at the end of THIS session — verify with `git log --oneline` and that the branch pushed.
2. To bring the board back with all changes: `ks-flow open` (auto-discovers the karmasuite project now; rebuilds web). Daemon already running on the migrated dir.
3. To finish GCS verification: add `GCS_BUCKET` + `GCS_CREDENTIALS` (service-account JSON path) to the data-dir `.env`, enable archiving in Settings, then `ks-flow archive <worktree>` and confirm a `<prefix>/<identifier>/{transcript,workflow}.tar.zst` lands in the bucket.
4. Optional: add a documented `KS_EXTRA_PLUGINS=` line to `plugins/ks/scripts/.env.example` (couldn't edit — `.env*` is permission/sandbox-blocked in this environment).
