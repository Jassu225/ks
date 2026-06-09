---
date: 2026-06-08T16:31:02+05:30
git_commit: 185259a
branch: feat/ks-flow-plugin
task: ks-flow plugin — Firestore credentials moved to env / $CLAUDE_PLUGIN_DATA/.env; web config decomposed into discrete env vars. Builds + validates; uncommitted.
---

# Handoff: ks-flow — Credential & Config moved to env / `.env`

> Builds on `handoffs/2026-06-08_13-20-27_ks-flow-plugin-built.md` (the full build + verification). This handoff is the **delta** since then: how Firestore is configured. Full design in `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`; dev guidance in CLAUDE.md.

## What Happened

The plugin was already fully built and verified last session (incl. live-emulator transport). This session reworked **how Firestore credentials and the board's client config are supplied** — away from a service-account JSON file path, toward environment variables backed by a single `.env` file that the always-on launchd daemon can actually read.

Three changes:

1. **Admin (daemon writer) creds via env, no SA file required.** `firestore.ts` now resolves the cloud credential in order: (1) client-email + private-key from env, (2) `firestore_credentials` JSON file (optional fallback), (3) Application Default Credentials. Private key restores `\n` escapes. Added `firestore_client_email` / `firestore_private_key` userConfig (sensitive); `config.ts` reads them with raw `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_PROJECT_ID` fallbacks. `bootstrap.sh` now propagates the two new keys into the launchd plist.

2. **`$CLAUDE_PLUGIN_DATA/.env` loader.** New `lib/envfile.ts` (no dep) — the launchd daemon never sees your shell, so it reads this one file at config load; **real env / userConfig still win** over the file. The board (`web/app/page.tsx`) mirrors the same loader so `ks-flow open` reads the identical file. File was named `ks-flow.env` mid-session, then renamed to **`.env`** at user request.

3. **Board web config decomposed into discrete env vars** (user noticed `projectId` repeated and `authDomain`/`storageBucket` are derivable). Replaced the single `FIREBASE_WEB_CONFIG` JSON with: `FIREBASE_API_KEY` (only new required field for cloud), `projectId` reused from `FIREBASE_PROJECT_ID`, `authDomain`→`<projectId>.firebaseapp.com`, `storageBucket`→`<projectId>.appspot.com`, optional `FIREBASE_APP_ID` / `FIREBASE_MESSAGING_SENDER_ID`. `BoardConfig.firebaseWebConfig:string` → `BoardConfig.firebase: FirebaseWebConfig|null`; `web/lib/firebase.ts` uses the object directly. userConfig `firebase_web_config` → `firebase_api_key` + `firebase_app_id`. Removed the daemon's now-unused `firebaseWebConfig` from `Config`.

## Key Decisions Made

- **`.env` in `$CLAUDE_PLUGIN_DATA`, not shell rc**, because the launchd daemon doesn't inherit `~/.zshrc`. One file both daemon and board read; precedence is real-env > file.
- **Env-first credential resolution** with file + ADC as fallbacks — keeps the SA-file path working but no longer requires it.
- **Reuse/derive over repeat** for the web config — only `FIREBASE_API_KEY` is genuinely new per project.
- **Deferred (offered, not done):** switching the board to read **server-side via the Admin SDK** (the already-built `FirestoreSource`), which would drop `FIREBASE_API_KEY` + all browser client config entirely. User hasn't taken it yet.

## Deviations from Plan

The plan specified a `firestore_credentials` file + a `firebase_web_config` JSON string. Both are superseded by the env-var approach above (file kept as optional fallback; JSON blob removed). This is a config-surface change only — architecture (writer/reader split, Firestore provider) is unchanged.

## Uncommitted Changes

Everything is still uncommitted on `feat/ks-flow-plugin` (nothing committed across either session):
- `plugins/ks-flow/` — entire plugin (untracked).
- `.claude-plugin/marketplace.json` — modified (ks-flow entry).
- `docs/` — untracked (the moved Symphony doc).
- Three handoffs in `handoffs/` (plan-approved, built, this one).

Touched this session: `plugins/ks-flow/.claude-plugin/plugin.json`, `src/lib/{config,envfile,db/providers/firestore}.ts`, `scripts/bootstrap.sh`, `web/{app/page.tsx,lib/{types,firebase}.ts}`. `src/dist` + `node_modules` are gitignored.

## Known Issues

- **Final `.env` config (`FIREBASE_*`) not exercised against the live emulator** — last session's transport test predates this refactor and used the SA-file path. The env→cert path compiles + is wired but unrun end-to-end. Re-run the emulator E2E (steps in the built handoff) with a `.env` to confirm.
- Carryover env caveats (this machine, not code): emulator needs `JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-24.jdk/Contents/Home` + an **unsandboxed** shell (sandbox blocks port binds); `fsevents` won't install (broken `~/.npm` → `sudo chown -R $(id -u):$(id -g) ~/.npm`); `terminal-notifier` not installed (`brew install terminal-notifier`).
- Keychain ~2KB cap on sensitive userConfig — the private key (~1.7KB) fits but leaves little room.

## Resume Point

State: code complete, **daemon + board both typecheck clean, `claude plugin validate` passes**. Nothing committed.

1. **Commit** (user hasn't asked yet). Branch `feat/ks-flow-plugin`. Suggested: scaffold + daemon + board + hooks as logical commits, or one feat commit. `.gitignore` already excludes build artifacts.
2. **Re-verify the env/cred path** end-to-end: create `~/.claude/plugins/data/ks-flow-karmasuite/.env` with `FIRESTORE_MODE`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_API_KEY`; start emulator (JAVA_HOME + unsandboxed); run daemon live (no `KS_FLOW_DRYRUN`); `ks-flow open` → confirm board renders columns + cards and updates live. Quick smoke without cloud: `KS_FLOW_DRYRUN=1 KS_FLOW_BACKFILL_ONLY=1 node src/dist/daemon.js` → `$CLAUDE_PLUGIN_DATA/dryrun-dump.json`.
3. **Optional:** take the deferred server-side admin-SDK board reader (drops all browser client config) — say so and it's a contained change to `web/` + a Next route reusing `FirestoreSource`.

Verify build first: `cd plugins/ks-flow/src && npm install --cache <writable> && npx tsc`, `cd ../web && npm install && npx tsc --noEmit`.
