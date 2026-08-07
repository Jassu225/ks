---
name: add-page-ai-chat
description: Wire a data-modifying Karmie AI chat onto a KarmaSuite page — new ReportAgentKind + handler file, tRPC→*Core extraction, AI tools, FAB/drawer client wiring, and (when the agent must interpret uploaded documents) an Anthropic Agent Skill authored and uploaded. Use when asked to add AI chat to a page, give Karmie write capabilities on a page, or wire up a new agent kind.
---

# Add AI Chat to a Page

KarmaSuite has a **pluggable per-page AI chat system** (built in KAR-12473; first adopter = Account Mapping tab). Adding chat to a new page means: one enum value, one handler file, one tools folder, one client component — the chat route, thread persistence, drawer/history UI, and streaming pipeline are all shared and unchanged.

**The Account Mapping implementation is the canonical reference for every step.** When in doubt, open the referenced file and mirror it. Full file map: `references/architecture-map.md`. Hard-won pitfalls: `references/gotchas.md` — read it before Phases 3–5.

## Working order

The phases below need not run strictly sequentially, but this order is optimal (proven by KAR-12473's refactor-first discipline):

1. **Phase 0 — Clarifying questions** (always first)
2. **Phase 1 — Survey the page's data layer** (read-only research)
3. **Phase 2 — Agent kind + skeleton handler** (small scaffold; unblocks the interactive DB migration early)
4. **Phase 3 — `*Core` extraction** (behavior-neutral refactor, own commits, existing tests = neutrality proof)
5. **Phase 4 — AI tools + handler `buildTools`**
6. **Phase 5 — Client wiring** (FAB, drawer, invalidation recipes)
7. **Phase 6 — Domain Agent Skill** (ONLY if the agent must process uploaded source files)
8. **Phase 7 — Optional anti-fabrication hardening**

Keep refactor commits (Phase 3) separate from feature commits — reviewers verify neutrality by "existing tests pass unchanged".

---

## Phase 0 — Clarifying questions

Ask the user (use AskUserQuestion where options are enumerable) before writing any code:

1. **Which page/tab?** Which React component renders it, and what URL/tab-state activates it?
2. **Scope entity** — is the page fund-scoped (a `fundId` is on the URL/props)? `AiThread` has a `fundId` column and `startThreadForKind` / `listThreadsByKind` already accept an optional `fundId` filter. Any OTHER scoping entity (org-only is fine; a different entity needs schema discussion — flag it).
3. **What must the agent READ and WRITE?** Enumerate the user-visible actions on the page (each maps to a tool). Which writes are destructive and need in-chat confirmation before the tool call?
4. **Feature flag** — dedicated Hypertune flag name? Precedent: `accountMappingAIChat` + `useIsAccountMappingAiChatEnabled.ts`. New flags are created in the Hypertune dashboard; the generated client dir is gitignored and regenerates at build (`pnpm hypertune:generate`).
5. **Source-file processing?** Will users upload documents (budgets, invoices, exports) the agent must interpret to do its job? If yes → Phase 6 applies; also ask NOW for (a) representative example source files and (b) what the correct resulting data in the DB looks like (an example fund/record set the user considers a correct outcome). These ground the domain skill.
6. **Save-as-agent semantics?** Almost always "none" for action-typed page chats (`mergeMode: "none"`, no `extractionPrompt`).
7. **Read-only history policy** — default is latest-thread-wins (only the newest thread of this kind for user+org+scope is writable; older ones open read-only). Confirm or adjust.

Immediately after answers, generate the skeleton handler (Phase 2) — it encodes the answers as `systemPromptContract` draft + default property values, and gives the user something concrete to react to.

## Phase 1 — Survey the page's data layer

Goal: a complete inventory of the **getter and setter tRPC procedures** the page uses. This drives Phases 3–5.

- Walk the page's component tree (component + hooks + cell renderers + sidebars/modals it opens). Collect every `rpc.*.useQuery`, `rpc.*.useMutation`, and `proxyRpc.client.*` call.
- For each **mutation**, record its `onSuccess` **invalidation recipe verbatim** (which `utils.*.invalidate()` calls + any refresh hook like `useFundMappingRefresh`). The AI tool for that write will replay exactly this recipe client-side (Phase 5).
- For each procedure, note: server file path, whether a `*Core` already exists, permission middleware (`withOrgProcedure` vs `withOrgAndPermissions` vs explicit checks), and side effects (audit log, Inngest triggers like `triggerFundDebouncedRefresh`, materialized-view refreshes).
- Also record client-side derivations done BEFORE calling a mutation (e.g. Account Mapping's grid derives `upperCapAmount` from the flex type before mutating) — the tool must replicate these or data drifts.

Produce a table: `procedure | server file | read/write | Core exists? | permission gate | side effects | client invalidation recipe | client-side derivations`. Present it to the user for scope confirmation.

Prefer Serena (`find_symbol`, `find_referencing_symbols`) for this sweep; delegate to `ks:codebase-analyzer` agents for large pages.

## Phase 2 — Agent kind + skeleton handler

1. **Enum**: add the new value to `ReportAgentKind` in `packages/prisma/prisma/schema.prisma` (alphabetical position). **The user runs the migration interactively**: `cd packages/prisma && pnpm migrate:dev` (and `pnpm migrate:reset:test` before later DB-backed test runs). Pause for this.
2. **Handler file**: `apps/www/src/server/ai/actions/<kindCamelCase>.ts` exporting `<kind>Handler: AgentKindHandler`. The contract type + JSDoc for every field lives in `apps/www/src/server/ai/actions/types.ts` — read it fully. Canonical rich example: `actions/accountMapping.ts`. Skeleton defaults:
   - `systemPromptContract` — draft from Phase-0 answers. Mirror the accountMapping contract's section structure: domain concepts/data model → scoping ("pinned to a single fund; never accept another id") → MANDATORY freshness rule (read-before-every-write, per write type) → grounding (no fabricated data) → money units (dollars; convert from cents) → name→id resolution via read tools ("never ask the user for raw ids") → confirmation-required list (destructive tools) → write behavior (report exactly what changed).
   - `mergeMode: "none"`, no `extractionPrompt` (save-as-agent disabled twice over).
   - `skills: []` — REQUIRED field, no defaults. Use `REPORT_SKILLS` from `anthropicConstants.ts` only if the kind produces document deliverables; Phase 6 replaces `[]` with a pinned custom skill constant.
   - `buildSystemPrompt: (ctx) => buildGenericSystemPrompt(ctx.files)` — minimal generic base (identity/structure/formatting) instead of the report-oriented prompt.
   - `isThreadReadOnly` — copy accountMapping's latest-thread-wins implementation, INCLUDING its fund-scoping fix (compute "latest" within the thread's own `fundId`, resolved via `aiThread.findUnique`).
   - `buildTools` — leave a stub throwing "tools not wired yet" (Phase 4 fills it).
3. **Register** in `apps/www/src/server/ai/actions/registry.ts` (one line).
4. **Thread plumbing**: nothing new needed — `startThreadForKind`, `listThreadsByKind`, `getLatestThreadForKind` in `routers/ai.ts` are kind-generic and already fund-aware.

Present skeleton + contract draft to the user; iterate before proceeding.

## Phase 3 — `*Core` extraction (behavior-neutral)

For every procedure from Phase 1 that a tool will need and that lacks a Core:

- Extract the `.mutation()`/`.query()` body **verbatim** into `<name>Core.ts` **next to the procedure file**. Ctx shape: `{ prisma, orgId, userId, inngest? }` (structural; `inngest` only when the body triggers events — see `FundWriteCoreCtx` in `funds/editFundBudgetGLTableCore.ts`). The procedure becomes a thin delegation.
- The Core's TS param type IS the convergence contract — **no shared Zod** between tRPC `.input()` and tool `inputSchema`; each layer defines its own and they converge at the Core param type.
- Keep ALL side effects in the Core: audit logging (`auditLog.*` needs only `{ prisma, orgId, userId }`), `setIsDefault*` helpers, Inngest triggers. Do NOT add side effects that don't exist today (behavior-neutral).
- **Permission middleware stays in the procedure** — the Core is permission-free; the AI tool re-checks explicitly (Phase 4 guards). Note which checks each tool must replicate.
- Return values: extend Core returns with fields the client invalidation recipe needs (e.g. `{ fundId, changedMappingFields }`) — the tool result rides the stream to the client dispatcher.
- Read `references/gotchas.md` § "Core extraction traps" (nested `$transaction`, App Router import graph, stale sibling `schema.ts` files, generated columns).

**Verification**: existing tests for those routers pass UNCHANGED (run with `dangerouslyDisableSandbox`, `TZ=UTC vitest run <path> --max-concurrency=1 --no-file-parallelism`). Commit refactors separately from feature work.

## Phase 4 — AI tools + handler `buildTools`

**Placement** (mirror `apps/www/src/server/ai/tools/accountMappingTools/` exactly):

- Page-specific tools → new folder `apps/www/src/server/ai/tools/<kind>Tools/` with **one file per tool** (`create<ToolName>Tool(ctx)` factories), `types.ts` (the `<Kind>ToolsCtx` interface), `guards.ts` (shared deny-before-write assertions), and `index.ts` that composes everything into a flat ToolSet with commented `── READ TOOLS ──` / `── WRITE / ACTION TOOLS ──` blocks.
- Tools reusable beyond this page → their own sibling folder (precedents: `expense-actuals/`, `employeeTools/`, `glAccountTools/`, `locationTools/`, `programTools/` — the dimension folders also show the "bundle create/lookup/getter per dimension" pattern and reuse `createOrgDataTools` getters).

**Per-tool rules**:

- Build every tool with `createDirectTool` (`tools/createDirectTool.ts`): `{ name, description (oneLine, tell the model when/how + returned shape), inputSchema (Zod with .describe()), execute → Core call, transform?, onSuccess?, onFailure? (log) }`. It handles Langfuse observe, `FormatUtils.jsonSafe` + truncation, and ZodError/TRPCError/Error → `{ error }` mapping (model self-corrects; never throw to the stream).
- **Pin the scope id from ctx** — tools NEVER accept `fundId` (or the page's scope id) as input.
- **Deny-before-write in every write tool**: `createPermissionedPrisma` intercepts READS ONLY. First line of each write execute = guard using the **edit-action** client (`createPermissionedPrisma(prisma, resources, "edit")`) verifying scope visibility + child-belongs-to-scope (see `accountMappingTools/guards.ts`). Procedure-level permission checks noted in Phase 3 must be re-checked here (e.g. `ClerkUtils.getUserPermissions(...).editAllPages`).
- Replicate client-side derivations recorded in Phase 1 inside the tool (or caps/amounts drift).
- Money: agent-facing values in **dollars** — divide stored ×100 values on read, multiply on write.
- Reads the agent needs for name→id resolution: reuse `createOrgDataTools` getters rather than writing new ones.
- Org-wide creation tools (if any): require `userApproved: z.literal(true)` (advisory speed bump), existence-check-first + skip-and-report-existing (retry-safe), provider-truth validation for QBO entities (see `glAccountTools`/`programTools`).

**Handler `buildTools`** (replace the Phase-2 stub; recipe in `actions/accountMapping.ts`): throw if scope id missing; `getPermissions(userId, orgId, null, prisma)` → `createPermissionedPrisma(...)` (+ edit variant); self-import singletons the ctx lacks (`inngest` from `@inngest/inngest`, `getNango()` from `@server/services`); return `create<Kind>Tools({...})`. `code_execution` is auto-appended by `streamInputs` for every kind — never add it yourself.

**Contract update**: extend `systemPromptContract` with per-tool guidance — the freshness-rule read↔write map, tool-selection notes, confirmation list naming actual tool names.

## Phase 5 — Client wiring

All shell pieces are **already reusable** — do not fork them: `AiGlobalFab`, `AiPageChatDrawer`, `AiThreadHistoryList`, `AiAgentChat` (has `readOnly`, `onStatusChange`, `emptyState`, `composerPlaceholder` props), `useChatToolResults`, `useAutoResume` (all under `client/components/AiChat/` + `client/components/AiAgentPage/AiAgentChat.tsx`, hook in `client/hooks/useChatToolResults.ts`).

Create ONE new component `<Page>AiChat.tsx` (`FC<{ fundId: number }>`), modeled line-by-line on `client/components/FundBudgetMergedTable/AccountMappingAiChat.tsx` (~380 lines — read it fully first). It handles:

- FAB click → resume `getLatestThreadForKind` if writable, else `startThreadForKind` (`{ kind, fundId }`); remount `AiAgentChat` via `key={threadId}`.
- Drawer with History toggle (left column via `AiThreadHistoryList`, `{ kind, fundId }`-filtered), "New chat" button with `window.confirm` (always, not only while streaming), read-only = `threadId !== writableThreadId`.
- Confirm guards for thread-switch/close mid-generation (track via `onStatusChange`).
- URL sync of open thread via nuqs `useQueryState("chatThreadId")` with the restore/validate/strip dance (copy it — it guards strict-mode double-invoke and deep-link races).
- **`onToolResult` dispatcher**: `switch (toolName)` → replay each write tool's manual-edit invalidation recipe from Phase 1 verbatim (fund-scoped where the manual path scopes). Parse `output` defensively (untyped from stream) for flags like `changedMappingFields`. `useChatToolResults` dedupes by `toolCallId` and its `seedSeenToolCalls` prevents history-loaded parts from firing refreshes — wire both.

**Mount + gating**: new flag hook (copy `useIsAccountMappingAiChatEnabled.ts`, ~12 lines), then in the page component: `{isTabActive && isEnabled && <PageAiChat fundId={fundId} />}`.

One component per file; `cn()` for classes; icons from `@karmasuite/react-icons`.

## Phase 6 — Domain Agent Skill (only for source-file processing)

Skip entirely unless Phase 0 established the agent interprets uploaded documents. If it does:

1. **Gather grounding from the user** (if not already): example source files (real budgets/invoices/exports, anonymized) + the correct resulting DB data (e.g. "here's a fund whose mapping is set up right from these documents"). Read both; also query the dev/Neon DB to see the created rows. The skill's extraction rules and worked examples come from these, not from imagination.
2. **Author** the skill at `apps/www/src/server/ai/skills/<skill-name>/`: `SKILL.md` (frontmatter `name` + rich `description` stating when to use; body = terminology, core model, source-of-truth hierarchy, workflow) + `references/*.md` for deep rules. Study `managing-account-mappings-and-budgets/` for structure and tone. Domain/enforcement semantics belong in the SKILL, not the prompt contract (precedent decision).
3. **Upload** via the generic `apps/www/scripts/skills/uploadSkill.ts` — create a thin wrapper script per skill (copy `uploadAccountMappingSkill.ts`):
   - First upload: `cd apps/www && pnpm script scripts/skills/upload<X>Skill.ts -- --create` → prints `skill_id` + `version`.
   - Pin a constant in `apps/www/src/server/ai/anthropicConstants.ts` (pattern: `ACCOUNT_MAPPING_SKILLS = [...REPORT_SKILLS, { type: "custom", skill_id, version }]` — spread REPORT_SKILLS only if document deliverables are needed) and set it as the handler's `skills:` field.
   - Version bumps thereafter: edit skill files → rerun the wrapper (no flag) → paste the printed version into the constant. The wrapper finds the id via the constant's `type === "custom"` entry — keep that lookup intact if reordering.
4. If the model must reference the skill by name, add a "Domain skill" section to the contract ("you must use this skill…"), mirroring accountMapping's.

## Phase 7 — Optional anti-fabrication hardening

Recommend when writes are destructive or the agent plans from documents. All precedents live in the accountMapping implementation; port, don't reinvent:

- **Provenance ledger + server-side write gate**: `ToolInvocationLedger` + `seedLedgerFromThread` (`accountMappingTools/shared/`), handler `createProvenanceLedger`, a `WRITE_TOOL_REQUIRED_READS` map (AND-of-groups / OR-within-group, mirroring the contract's freshness rule) + the provenance wrapper loop in the tools `index.ts` (returns `{ error }`, never throws). Skill-read gate included if Phase 6 shipped a skill.
- **Ungrounded-claims retry gate**: handler `detectUngroundedClaims(strippedText, ledger)` with a TIGHT `DATA_CLAIM_PATTERNS` regex set (false negatives OK, false positives not) + `READ_TOOL_NAMES` export; the route's two-pass retry loop picks the critique up automatically.
- **Contract hardening**: grounding section ("every number must come from a tool result visible in this thread").

## Verification & shipping

- Server sweep: `cd apps/www && TZ=UTC vitest run tests/server/ai --max-concurrency=1 --no-file-parallelism` (dangerouslyDisableSandbox — DB on localhost). Router suites touched by Phase 3 pass unchanged. Client suite for touched components.
- Static-mock suites (`claimsFileButNoneArrived.test.ts` etc.) WILL break when `buildTools` grows the import graph — fix by extending their manual mocks in place (see gotchas).
- Manual E2E checklist: FAB visible only on the target tab with flag on → fresh chat → a read, a write, grid/page refreshes live without reload → history list scoped to page entity → old thread read-only (composer hidden; direct POST 403s) → mid-generation switch/close confirms.
- Hooks handle prettier/eslint/tsc on Stop — do not run them manually; DO run them on modified files before pushing (CLAUDE.md).
- Ship as a stacked PR sequence when large (KAR-12473 precedent: framework refactor → cores → kind skeleton → tools → UI → skill/prompt).
