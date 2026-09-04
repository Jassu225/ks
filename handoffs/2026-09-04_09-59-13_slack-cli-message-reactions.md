---
date: 2026-09-04T09:59:13+05:30
git_commit: 67604f6
branch: main
task: Carry message reactions through the slack CLI's thread/history projections
---

# Handoff: Reactions in the `slack` CLI

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

A peer session tracking a decision thread on KAR-12844 reported a stakeholder as unresponsive — twice — and told its user the work was blocked pending his reply. He had already approved, with a 👍. `slack message thread` showed nothing after his last text message.

Cause: both message-reading commands project each raw Slack message onto a fixed field set, and `m.reactions` was not in it.

- `getChannelHistory`, the `messages.map` in `plugins/ks/scripts/slack-cli.ts` (was :491) — `ts, user, text, type, subtype, threadTs, replyCount, datetime`
- `getThread`, the `messages.map` (was :798) — same, plus `isParent`, minus `replyCount`

Because the projection is lossy, `--json` could not recover it either — the reactions never left the map. `reaction list` was unaffected (it passes Slack's payload straight through), which is why it could see the 👍 and the thread reader could not.

Fix, in `plugins/ks/scripts/slack-cli.ts`:

- `projectReactions(m)` — carries `{ name, count, users }`, returning `undefined` (not `[]`) when a message has none, so `--json` does not grow a noisy empty array on every unreacted message. Used by `getThread`, `getChannelHistory`, and `searchMessages`.
- `formatReactionLine(reactions, nameFor?)` — one line under the message text, `:+1: 2  :eyes: 1`, with reactor names appended when a namer is supplied.
- `userNamer(client, enabled)` — returns an id→name function, or identity when disabled. Built from the already-cached `allUsers()`.
- `--names` on `message thread` and `channel history` — resolves user IDs to display names for **both** message authors and reactors. Opt-in because it costs a full `users.list` walk.

Verified live against the thread that exposed the bug (`C05EY2TMDCN` / `1788362803.546119`): 11 messages carry reactions, from six people, including all three the peer could previously only reach via `reaction list` — ts `1788452017.262999` (`+1`, U04Q8S9BF70), `1788451859.758779` (`+1` ×2, U04Q8S9BF70 + U0B8P8YKZ88), `1788391945.536469` (`+1`, U04Q8S9BF70). Text mode with `--names` renders the approval as `:+1: 2 (jon, Kat Buffington)`. `channel history --names` verified on the same channel.

## Key Decisions Made

- **`undefined` rather than `[]` when there are no reactions.** Keeps `--json` readable and makes `select(.reactions)` the natural filter. `projectReactions` checks `.length`, so a `[]` from Slack also collapses to absent.
- **`--names` covers message authors too, not just reactors.** Same lookup map, and the raw `U…` author IDs were the other half of the same readability problem. Default output is unchanged — no flag, no `users.list` call.
- **Opt-in rather than automatic naming.** Resolving means walking every workspace member; a `channel history --limit 5` should not pay for that unasked.
- **`searchMessages` gets the passthrough but a documented caveat.** Slack does not appear to return reactions on search matches, so absence there proves nothing. Carrying the field through costs one line and future-proofs it; the docs say to re-read with `message thread` before concluding a message was unreacted.
- **Left `pins list` alone.** It outputs Slack's raw items under `--json`, so reactions were never lost; its text branch is a pin inventory, not a read surface for answers.

## Deviations from Plan

The peer's report predicted the verification command would return `3` after the fix. It returns `11`. The peer derived 3 from `slack reaction list U04Q8S9BF70`, which reports only that one user's reactions, and later sent a correction confirming 11 is right. Anyone re-running that check should expect 11.

## Uncommitted Changes

None — committed and pushed to `jassu`, then `origin`.

Files touched:
- `plugins/ks/scripts/slack-cli.ts` — reaction projection, formatting, `userNamer`, `--names` on two commands
- `plugins/ks/commands/slack.md` — "Reactions are answers" note, `reactions[]` in the `--json` key-style inventory, `--names` examples, cross-reference from the Reactions section

## Known Issues

- `plugins/ks/scripts/quality-lint.sh` still fails with `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE` — it points at the karmasuite workspace, not this repo. Pre-existing, unrelated. `plugins/ks/scripts/node_modules/.bin/tsc --noEmit -p tsconfig.json` is clean. Note `npx tsc` does **not** work here (npx grabs the wrong `tsc` package); use the local binary.
- Whether `search.messages` ever returns reactions is unverified — the raw payload could not be inspected, since reading `scripts/.env` is sandbox-blocked and only the `slack` binary itself runs unsandboxed. The code handles both cases.
- `--names` is human-output only. `--json` still emits raw IDs in `reactions[].users` and in `user`, deliberately, so JSON consumers keep stable identifiers.

## Resume Point

Nothing is blocked. If picking this up further:

- Sanity check:
  ```bash
  slack message thread C05EY2TMDCN 1788362803.546119 --json | jq '[.[] | select(.reactions)] | length'   # 11
  slack message thread C05EY2TMDCN 1788362803.546119 --names | tail -20
  ```
- Any **new** command that maps raw Slack messages must call `projectReactions` — that lossy-projection pattern is what caused this. `getThread`, `getChannelHistory`, and `searchMessages` are the three that exist today.
- If `--names` is wanted in `--json`, add a sibling field (e.g. `userName`, `reactions[].userNames`) rather than overwriting the IDs.
- `reaction list <user>` remains the only way to ask "what has this person reacted to across the workspace"; the new fields answer the inverse, "who reacted to this message".
