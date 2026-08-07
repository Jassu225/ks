# Gotchas — hard-won during KAR-12473

Every item below cost a debugging session or a review finding. Check the relevant section before each phase.

## Core extraction traps (Phase 3)

- **Nested `$transaction` crashes.** If a Core runs inside `$transaction` and calls a helper that itself opens `prisma.$transaction`, Prisma throws (no savepoints). Extract a `<helper>InTx({ tx })` variant operating directly on the tx client; keep the standalone helper for non-tx callers. Precedent: `setEmployeesInTx` in `funds/budget/updateFundBudgetCategory/`.
- **Stale sibling `schema.ts` files.** Some procedure folders contain outdated Zod files (e.g. `updateFundBudgetCategory/schema.ts` had singular `employeeId`). Mirror the **inline** procedure Zod, never a sibling schema file, when typing the Core input.
- **Postgres STORED generated columns** (e.g. `FundBudgetCategory.name`) must never be written — write the source columns.
- **Rename/side-effect propagation must move with the Core** (e.g. `fundPlannedBudgetCategory` rename propagation) or scenario copies drift.
- **`getOrgAccountingProvider` UPSERTS `orgConfiguration`** — call once per Core invocation, never in loops.
- **MV refresh + `refreshValidGLItemsForAccounts` cannot run inside an interactive transaction.** Batch them once per Core call, not per row.
- **Client-side derivations**: the UI sometimes computes values before mutating (upper-cap derivation from flex type; auto-flip to `custom` mode before cap writes). The tool must replicate them server-side or values drift 100×/stale.
- **Cents vs dollars**: DB stores ×100. Agent-facing = dollars. A subagent once wrote 100×-off values — verify conversion in both directions.
- Some enum types live in CLIENT files and get imported by server code (pre-existing violations). When a Core needs one, move the enum to `packages/utils/src/enums.ts` (NOT `packages/typings` — it's .d.ts-only) and update both import sites. `@karmasuite/utils` ships from built `dist/` — rebuild after editing.

## Tools + handler traps (Phase 4)

- **`createPermissionedPrisma` intercepts READS ONLY.** Writes pass through untouched. Every write tool needs explicit deny-before-write using the `"edit"`-action client — view-only access must not pass. The underlying tRPC mutations often have NO server-side edit check (UI-gated only); the tool cannot rely on them.
- **`code_execution` is appended route-side for every kind** (`streamInputs`) — a handler toolset without it broke container skills ("skills can only be used when a code execution tool is enabled"). Never add it in `buildTools`; never remove the route-side append.
- **`check_time_budget` is route-level for all kinds** — don't add per-toolset.
- **Remove/delete paths need server-resolved keys**: the model knows entity ids, not join-row ids. Resolve join rows (+ flags like `isAllGeneralLedgerItems`) inside the tool with a fresh read; self-heal on miss.
- **Never call tRPC / `createCaller` from tools** — settled NO (KAR-11876). Cores + Prisma only. Also: `createCaller(ctx)` from any file inside the appRouter import graph creates a router→root circular import that crashes module init.
- **`server-only` markers break pages-router builds** when the tools graph becomes reachable from `routers/ai.ts` → `pages/api/trpc`. Symptom: Vercel build throw. Workaround in place: runtime `typeof window` guards in `uploadThing fetchFile/signFileKey`. Follow-up = registry split (metadata vs execution). Watch for reintroduction when adding imports to handlers.
- **Return-shaped errors, never throws**: `createDirectTool` maps errors to `{ error: string }` so the model self-corrects. Gates/guards must do the same.
- Tool results should carry a `kind`/flags the client dispatcher branches on (`changedMappingFields`, `switchedToCustom`) — parse `output` defensively client-side (untyped from stream).

## Client traps (Phase 5)

- **Seed the seen-set before pushing history messages** (`seedSeenToolCalls`) or opening an old thread replays every write tool's invalidation → spurious refresh storm.
- Tool parts arrive in TWO shapes: live `part.type === "tool-<name>"` vs history-reconstructed `type === "dynamic-tool"` + `toolName`. `useChatToolResults` handles both — use it, don't hand-roll.
- **Read-only via `writableThreadId` state** (`readOnly = threadId !== writableThreadId`), not a one-way `readOnly: true` on select — otherwise users get stranded read-only. FAB reopen must target the writable thread.
- Invalidation recipes are **per-tool, copied from the manual edit path** — a union recipe over-invalidates; a missing entry leaves the grid stale. `refreshFundMapping` (GL recompute) only where the manual path fires it.
- Latest-thread-wins caveat: a second tab's FAB makes the first tab read-only (accepted). Ensure `isThreadReadOnly` scopes "latest" by the page's entity (fundId), not just user+org+kind.
- nuqs URL-sync needs the restore/validate/strip dance from `AccountMappingAiChat.tsx` (strict-mode double-invoke ref guard; validate deep-linked thread against `listThreadsByKind`; known deferred race: deep-link restore vs FAB click).
- Auto-resume: threads without a genesis snapshot allow max 2 consecutive `[[CONTINUE]]` resumes (progress guard) — expected, not a bug.

## Test traps

- **Static-mock suites break on import-graph growth.** `tests/server/ai/claimsFileButNoneArrived.test.ts` (and friends) hand-mock `@karmasuite/prisma`/`@karmasuite/utils`; new handler imports (Cores, Inngest singleton, general-ledger-external) surface as missing enum/util stubs. Fix by extending the mocks in place.
- Handlers importing the tools index pull the uploadThing chain → server tests may need `vi.mock("server-only", () => ({}))` (established pattern in `tests/server/ai/`).
- `anthropicFetchWrapper.test.ts` asserts skill-constant composition (REPORT_SKILLS spread FIRST, exactly one custom entry) — reordering a skills constant breaks it.
- Stale generated Prisma client / stale test-DB enums after migrations → `prisma generate` + `pnpm migrate:reset:test` before blaming code.
- DB-backed runs: `dangerouslyDisableSandbox: true`, `TZ=UTC vitest run <path> --max-concurrency=1 --no-file-parallelism`.

## Skill upload traps (Phase 6)

- Upload wrapper scripts run via `cd apps/www && pnpm script scripts/skills/<wrapper>.ts` (needs `ANTHROPIC_API_KEY`); `@server/*` aliases DON'T resolve under `tsconfig.script.json` — use relative imports in scripts.
- The wrapper locates the skill id via the constant's `type === "custom"` entry — index-0 lookup broke once when `REPORT_SKILLS` was spread in front.
- Flow after every skill edit: rerun wrapper → paste printed version into the pinned constant → commit both. Forgetting the constant bump means production serves the old skill.
- Anthropic skills are for **authoring/doing**; document READING comes from native PDF blocks / code execution — don't write a skill to "read PDFs".
- Hypertune generated dir is gitignored; new flags appear on build via `pnpm hypertune:generate` — nothing to commit for flags.

## Prompt/contract lessons

- Kind contract is layered TOP of the prompt (`applyAgentLayers`) — it wins; keep it authoritative and self-contained.
- Domain/enforcement semantics → the SKILL; tool mechanics + confirmation rules + freshness map → the CONTRACT. Don't duplicate across both (fund-identity guidance was added to the contract and reverted).
- Prompt-only guards WILL be ignored under pressure — a production transcript showed wholesale fabrication of tool results. If writes matter, ship Phase 7 (server-side gates), not just prompt language.
- Confirmation rules: enumerate exact tool names + consequence ("cascades and overwrites", "resets all caps to 0") and close with "for all other writes, proceed without extra confirmation" — otherwise the model over-asks.
