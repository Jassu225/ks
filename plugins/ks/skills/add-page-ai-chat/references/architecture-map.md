# Pluggable Per-Page AI Chat — Architecture Map

All paths relative to the karmasuite repo root. Built in KAR-12473 (PR stack #6364–#6369); Account Mapping tab = reference adopter.

## Request flow

```
<Page>AiChat.tsx (client)
  └─ AiAgentChat → POST /api/ai/chat  (App Router: apps/www/src/app/api/ai/chat/route.ts)
       └─ prepareStreamInputs (streamInputs.ts)
            ├─ thread lookup → agentKind = thread.kind (source of truth)
            ├─ handler = getAgentKindHandler(kind)          (actions/registry.ts)
            ├─ handler.isThreadReadOnly? → 403 channel
            ├─ handler.createProvenanceLedger? → ledger on toolCtx + StreamContext
            ├─ tools = handler.buildTools(toolCtx) ?? buildDefaultToolset(toolCtx)
            │    (+ code_execution ALWAYS appended by streamInputs — never per-handler)
            └─ prompt = buildPrompt → handler.buildSystemPrompt? else legacy branches;
                 applyAgentLayers([handler.systemPromptContract, agentPrompt, base]) — kind contract wins
       └─ streamText (claude model, stopWhen stepCount+deadline) → two-pass retry-gate loop
            └─ streamCallbacks: onStepFinish (ledger.observeCodeText for skill reads),
               onFinish (handler.detectUngroundedClaims → retry critique; postHarvestValidate)
```

## Server files

| Concern | Path |
|---|---|
| Handler contract + all hook JSDoc | `apps/www/src/server/ai/actions/types.ts` (`AgentKindHandler`, `ToolBuildContext`, `SystemPromptBuildContext`) |
| Registry (one line per kind) | `apps/www/src/server/ai/actions/registry.ts` |
| Rich handler example | `apps/www/src/server/ai/actions/accountMapping.ts` |
| Neutral handler examples | `actions/general.ts`, `actions/fundReport.ts` |
| Generic base prompt | `apps/www/src/server/ai/prompts/genericSystemPrompt.ts` (`buildGenericSystemPrompt`) |
| Tool wrapper factory | `apps/www/src/server/ai/tools/createDirectTool.ts` (Langfuse observe, jsonSafe+truncate, error→`{error}`, `onSuccess`/`onFailure`) |
| Page toolset reference | `apps/www/src/server/ai/tools/accountMappingTools/` (one file per tool; `types.ts` ctx; `guards.ts`; `index.ts` with READ/WRITE blocks, `WRITE_TOOL_REQUIRED_READS`, `READ_TOOL_NAMES`, provenance wrapper) |
| Reusable-tool folders | `tools/expense-actuals/`, `tools/{employee,glAccount,location,program}Tools/` (dimension bundles: getter + lookup + create) |
| Org-data getters to reuse | `tools/orgDataTools.ts` (`createOrgDataTools`) |
| Default toolset (kind-less threads) | `tools/index.ts` (`buildDefaultToolset`; permissioned-prisma recipe at its top) |
| Provenance ledger | `tools/accountMappingTools/shared/toolInvocationLedger.ts`, `shared/threadToolUsage.ts` (`seedLedgerFromThread`) |
| Permissions | `server/utils/permissions/getPermissions.ts`, `createPermissionedPrisma.ts` (READS ONLY; third arg `"edit"` for the edit-action client) |
| Thread procedures (kind-generic, fund-aware) | `server/api/routers/ai.ts`: `startThreadForKind`, `listThreadsByKind`, `getLatestThreadForKind`, `listMessages` |
| Skill constants | `apps/www/src/server/ai/anthropicConstants.ts` (`REPORT_SKILLS`, `ACCOUNT_MAPPING_SKILLS`, `AnthropicSkill`, `SKILLS_BETA`) |
| Skill sources | `apps/www/src/server/ai/skills/<skill-name>/` (SKILL.md + references/) |
| Skill upload scripts | `apps/www/scripts/skills/uploadSkill.ts` (generic) + `uploadAccountMappingSkill.ts` (thin wrapper pattern) |
| Write-Core example | `server/api/routers/funds/editFundBudgetGLTableCore.ts` (`FundWriteCoreCtx`) |
| Debounced refresh trigger | `server/api/routers/expenseActuals/triggerFundDebouncedRefresh.ts` (ctx `{inngest, orgId, prisma}`) |

## Client files (all reusable — fork nothing except the page component)

| Concern | Path |
|---|---|
| Page chat component reference | `apps/www/src/client/components/FundBudgetMergedTable/AccountMappingAiChat.tsx` (FAB→thread lifecycle, drawer, history, read-only, URL sync, onToolResult dispatcher) |
| Chat surface | `client/components/AiAgentPage/AiAgentChat.tsx` (props: `threadId`, `readOnly`, `onStatusChange`, `emptyState`, `composerPlaceholder`) |
| FAB | `client/components/AiChat/AiGlobalFab.tsx` |
| Drawer shell | `client/components/AiChat/AiPageChatDrawer.tsx` |
| History list | `client/components/AiChat/AiThreadHistoryList.tsx` (kind+fundId scoped; "Current" = top row of updatedAt-desc list) |
| Tool-result detection | `client/hooks/useChatToolResults.ts` (`toolCallId` dedupe + `seedSeenToolCalls` history seeding) |
| Auto-resume | `client/components/AiChat/useAutoResume.ts` (`[[CONTINUE]]` loop) |
| Flag hook pattern | `client/components/AiChat/useIsAccountMappingAiChatEnabled.ts` |
| Mount example | `FundBudgetMergedTable.tsx` (~line 236): `{isGLMappingsActive && isEnabled && <AccountMappingAiChat fundId={fundId} />}` |
| Refresh hook | `client/hooks/useFundMappingRefresh.ts` (single-flight broken-restriction recompute) |

## AgentKindHandler quick contract

Required: `systemPromptContract: string`, `mergeMode: "none"|"one-shot"|"smart-merge"`, `skills: readonly AnthropicSkill[]`.
Optional hooks: `extractionPrompt` (presence = save-as-agent enabled), `buildTools(ctx)`, `buildSystemPrompt(ctx)`, `isThreadReadOnly(args)`, `createProvenanceLedger(ctx)`, `detectUngroundedClaims(text, ledger)`, `matchesArtifact`, `buildReplayPrompt`, `postHarvestValidate`.

`ToolBuildContext`: `{ threadId, orgId, userId, fundId?, prisma, anthropicFileIds, restorableFiles?, ledger? }`. Handlers self-import singletons the ctx lacks (`inngest` from `@inngest/inngest`, `getNango()` from `@server/services`).

## The `*Core` pattern

tRPC procedure body → exported `fooCore(ctx, input)` beside the procedure; procedure thin-delegates; AI tool calls the Core directly with permissioned/raw Prisma. Convergence contract = the Core's TS param type (NO shared Zod between tRPC `.input()` and tool `inputSchema`). Ctx: `{ prisma, orgId, userId, inngest? }`. Permission middleware stays in the procedure; tools re-check via guards. This replaced the deleted createCaller/HTTP-loopback bridge (KAR-11876) — **never call tRPC from tools**, and App Router code must never import tRPC routers (import-graph constraint documented in `server/services/fundDetailsPdf/fetchFundDetailsData.ts`).
