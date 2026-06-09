# KarmaSuite `/ks` → Symphony-Claude — Conversion Feasibility

> Analysis date: 2026-06-01. Question: "Can we convert the current `/ks` workflow into Symphony-Claude's workflow?"
> Source: multi-agent workflow `symphony-conversion-feasibility` (10 agents) + web research on OpenAI Symphony + the `symphony-claude` fork.

---

## 0. What Symphony is (background)

- **Open-source spec + Elixir reference implementation** released by OpenAI (the Codex team), ~late April 2026, at `github.com/openai/symphony`. The **spec is the deliverable**; OpenAI will **not** maintain it as a standalone product.
- It is **not a CLI you type into** and **not a chat tool**. It is a **long-running supervisor/daemon** that:
  1. Polls an issue tracker (**Linear**, the only supported `kind`) on an interval.
  2. Auto-provisions an **isolated workspace per ticket**.
  3. Runs a coding agent in a loop (multiple "turns") until the work becomes a **mergeable PR**.
  4. Hands off to humans via **tracker state transitions** (e.g. a `Human Review` state).
- Core philosophy: change the agent's goal from "answer a prompt" to **"convince a human to merge this code."**
- Config lives in a single **`WORKFLOW.md`** = **YAML front-matter + Jinja2-templated Markdown prompt body** (variables like `{{ issue.identifier }}`, `{% if attempt %}` retry blocks). **Not slash commands.**
- Reference targets **OpenAI Codex in "app-server mode"** (headless, JSON-RPC over stdio).

### Claude Code support
- **Not official / not out-of-the-box.** Claude Code lacks native JSON-RPC.
- The spec is **agent-agnostic** (launches any agent via `bash -lc`, talks stdio JSON lines), which makes adapters feasible.
- **`symphony-claude`** (sapsaldog fork) = an app-server shim wrapping Claude Code in Symphony's JSON-RPC 2.0 protocol. Refactors Symphony around a pluggable `CodingAgent` behavior (separate Codex / Claude impls). Setup: `claude auth`, install `symphony-claude` via Homebrew, write `WORKFLOW.md` with a `claude: { command: symphony-claude }` agent block.
  - Runtime invocation: `claude -p --output-format stream-json --verbose --resume --mcp-config`, prompt piped via stdin. `thread_id` reused for continuation; `session_id = "<thread_id>-<turn_id>"`.
  - Known quirk: positional prompt parsing breaks when `--mcp-config` is present (handle stdin-prompt carefully).
- A separate community fork pairs Claude Code with **GitHub Issues** instead of Linear.

---

## 1. VERDICT

**Feasible-with-caveats, but NOT worth it for the KS team as-is.**

The conversion is mechanically achievable, but it requires **discarding KS's two defining features** (the persisted multi-phase state machine and the synchronous per-phase human gates) and **rebuilding three subsystems with strictly weaker enforcement**.

**Recommendation: stay put, or at most run a narrow hybrid** (see §6).

---

## 2. The core blocker — philosophy inversion

**Autonomy-vs-per-phase-human-gate conflict is structural, not a config knob.**

- **Symphony runtime** = unattended polling daemon of resumable per-issue workers running `approval_policy: never`, `sandbox: workspace-write`. Design axioms: "never ask a human", "runs must not stall indefinitely". No mid-turn confirmation, no per-tool approval, no chat-with-agent channel.
- **KS runtime** = the inverse. A synchronous human gate at **every** boundary. Nine named checkpoints:
  1. "Which phase to start?"
  2. "Ready to start Phase X?"
  3. Per-phase manual verification **before each commit**
  4. ExitPlanMode plan approval (Phase 9 — **zero source edits until approved**)
  5. Analyzer clarifying questions via AskUserQuestion (Phase 10)
  6. "Mark COMPLETED?" after each phase
  7. Architect `NEEDS REVISION` loop → `REJECTED` → literal **`override approved`** escape hatch
  8. Per-Linear-post confirmation before posting
  9. Session-boundary "start fresh" restarts

Symphony has **no orchestrator-level pause**, so all 9 KS checkpoints must collapse into ~3 coarse **async** tracker states (`Backlog` / `Human Review` / `Rework`). You don't *configure* this away — you **delete KS's control model** and re-express surviving gates as asynchronous Linear state moves. The per-phase confirmation the KS team values most *is* the thing Symphony's architecture forbids.

**Second blocker (rides alongside):** KS's persisted 10-phase state machine (Revisit/Invalidate cascade, iteration versioning in `iterations[]`, schema-validated `state.yaml`) has **no representation** in Symphony — state collapses to "agent-driven Linear status + one Markdown workpad comment." Ground-up rebuild.

---

## 3. What converts cleanly (cheap wins)

- **Linear API plumbing** — `$LINEAR_API_KEY`, GraphQL endpoint, project scoping all carry over unchanged. KS already speaks Linear.
- **Git worktree isolation primitive** — one-worktree-per-unit-of-work maps conceptually to Symphony's per-issue `workspace.root` + sanitized-identifier scheme.
- **The Codex→Claude swap itself** — replacing the `codex:` block with `claude: { command: symphony-claude }` is genuinely a one-block edit; the rest of `WORKFLOW.md` is agent-agnostic.
- **Architect review + post-PR code-review logic** — survive *as tools the worker runs inside its turn* before self-routing to Human Review. The logic survives; only the human gates around them don't.
- **Serena + code-review plugin** — re-wire into the per-workspace `--mcp-config` / worker prompt.

---

## 4. What must be rebuilt or discarded

### Rebuilt (weaker enforcement)
- **Quality gates (format/lint/typecheck)** — headless `claude -p` **never fires Stop/SubagentStop hooks**, so the non-bypassable `exit 2` blockers must move into `WORKFLOW.md` as advisory Validation-checklist commands or `before_run`/`after_run` workspace hooks. You **lose** automatic, non-bypassable, changed-files-scoped enforcement.
- **Worktree bootstrap** — `ks-start-*` interactive scripts → Symphony `after_create` clone hook + `before_run` setup. ⚠️ `pnpm install` on this monorepo likely **exceeds the 60s `timeout_ms`** — needs a bump.
- **Tracker integration role** — flips from passive Linear mirror to **active control plane**; build the poll/claim/dispatch/retry loop KS lacks, plus a `linear_graphql` MCP tool for agent self-transition.
- **Subagent topology** — KS's conductor + parallel-implementation-subagents (max 5) + plan-analyzer + architect-as-subagent have **no analog** (Symphony has no in-session fan-out; each issue = one resumable worker thread). Re-express as skills the single worker invokes, or as separate Linear issues.
- **The Codex Workpad comment** — new persistent-scratchpad convention (`## Codex Workpad`: Plan / Acceptance Criteria / Validation / Notes) replacing `state.yaml` + handoff `.md` files.

### Discarded (genuine losses)
- The **persisted 10-phase state machine** + Revisit/Invalidate cascade + iteration versioning.
- **All synchronous human gates** (the nine checkpoints).
- **Neon `protect-neon-branch.sh` PreToolUse deny** — ⚠️ **TRUE SAFETY REGRESSION.** Symphony has no per-tool interception. The production-branch guard (hard-blocks branch `br-round-breeze-217777`) **cannot be reconstructed as a hook**; it must move out-of-band (Neon-side branch protection or scoped credentials in the per-workspace MCP config). An unattended agent with no per-tool approval is **materially riskier** than today.

---

## 5. Concrete conversion path (IF proceeding)

1. **Install the adapter** — `claude auth` once; install `symphony-claude`; confirm `symphony-claude start` (WebSocket) connects as the Codex app-server shim. Validate the stdin-prompt + `--mcp-config` quirk.
2. **Stand up Linear states** — create the workflow state set: `Backlog`, `Todo`, `In Progress`, `Human Review`, `Rework`, `Merging`, `Done`; set `active_states` / `terminal_states`.
3. **Write `WORKFLOW.md`** — YAML front-matter (`tracker`, `polling`, `workspace.root`, `agent` concurrency/turns/backoff, `claude: { command: symphony-claude }`) + Jinja2 prompt body. Bake the KS phase pipeline into the prompt as an explicit checklist the single worker executes, plus the routing table per tracker state.
4. **Map states (the hard design step)** — collapse the 9 KS checkpoints → tracker states. Plan-approval → self-route to Human Review (human approves via Linear comment/state move). Architect `REJECTED` → self-route to Human Review; human moves to Rework (full reset, fresh branch from `origin/main`). Per-phase verification → gone (agent commits/pushes unattended) or re-expressed as Human Review pauses if latency is tolerable.
5. **Port hooks** — worktree setup → `after_create` (clone) + `before_run` (pnpm install, **bump `timeout_ms` well past 60s**). Quality gates → Validation-checklist commands in the prompt (run before routing to Human Review/Merging) and/or `after_run`. `code-review-graph` continuous indexing → `after_run` or drop.
6. **Relocate the Neon guard out-of-band** — enable Neon-side protection on `br-round-breeze-217777` and scope per-workspace MCP credentials to dev branches only. Do **not** rely on a prompt convention for this.
7. **Add the Codex Workpad convention** — keep the literal `## Codex Workpad` marker + fingerprint line (`<hostname>:<abs-path>@<short-sha>`); map Plan/Acceptance Criteria/Validation/Notes sections to KS's AC-N blocks.
8. **Wire MCP** — per-workspace `--mcp-config` exposing `linear_graphql`, Serena, and code-review; verify cost tracking surfaces in `turn/completed`.
9. **Pilot on tickets only** (KS phases 1, 2, 9, 10) before attempting full project workflows (phases 3–8 are the heaviest human-collaboration phases and convert worst).

---

## 6. Recommendation

**Stay put — or at most run a narrow hybrid.**

Reasoning tied directly to the KS team's stated preference for per-phase confirmation: **that preference *is* the thing Symphony's architecture structurally forbids.** Converting forces a trade of the single most-valued property (synchronous, fine-grained human steering at every phase) for unattended autonomy that hasn't been asked for — while *also* taking a real safety regression on the Neon production-branch guard and downgrading non-bypassable quality gates to advisory prompt text.

**If there is genuine appetite for autonomy on a *subset* of work — run a hybrid:**
- Keep `/ks` exactly as-is for **projects and high-touch tickets**.
- Stand up Symphony-Claude on a **separate, well-bounded queue** of low-risk, mechanically-specified tickets (e.g. dependency bumps, isolated bug fixes with clear ACs) where unattended end-to-end execution is acceptable and the Neon/quality-gate risks are contained.
- **Do not attempt a full cutover** — you would be rebuilding three subsystems to land in a model that contradicts the team's core working preference.

---

## 7. Per-dimension gap analysis

| Dimension | Difficulty | One-line reason |
|---|---|---|
| tracker-integration | **HARD** | Linear plumbing reuses, but role inverts passive mirror → active control plane (poll/dispatch loop, state enum, agent self-transition, Workpad comment). |
| agent-runtime | **BLOCKER** | KS = interactive human-gated single session w/ in-session subagent fan-out; Symphony = unattended polling daemon of resumable workers (`approval_policy: never`) — autonomy negates KS gates + topology. |
| state-machine | **BLOCKER** | KS's persisted, human-gated phase/iteration machine has no representation; collapses to agent-driven Linear status + Markdown workpad — ground-up redesign. |
| hooks-and-quality-gates | **HARD** | Headless `claude -p` never fires harness hooks; all 5 gates rebuild as workspace-hooks/prompt with weaker enforcement; Neon PreToolUse deny is a genuine safety regression. |
| human-in-loop-granularity | **BLOCKER** | KS = synchronous gate at every phase; Symphony = "never ask a human / must not stall" — every checkpoint discarded/re-expressed as coarse async tracker states. Model inversion. |
| workspace-isolation | **MODERATE** | Worktree primitive maps cleanly, but inverting human-seeded persistent worktrees → auto-provisioned/torn-down workspaces means rewriting bootstrap as hooks (+ pnpm timeout bump) and abandoning resumable-handoff model. |

### 7.1 tracker-integration — HARD
- **Current:** Linear is system-of-record but a **passive data store**, never a driver. All reads/writes via the mediated `/ks:linear` skill (never raw CLI/API). Bootstrap scripts (`ks-start-project`, `ks-start-ticket`) are the only direct Linear SDK callers — hit Linear once to seed `state.yaml`, never poll again. `ticket.status`/`project.status` is a free-form passthrough mirror (`{id,name}`, not enumerated); the workflow does **not** advance on Linear status. Real state machine = local `phases[]` in `state.yaml`.
- **Symphony:** Tracker is the **PRIMARY control plane.** `tracker:` block declares `endpoint`, `api_key: $LINEAR_API_KEY`, `project_slug`, `active_states`, `terminal_states`. Continuous poll loop fetches active-state candidates, sorts by priority/creation, dispatches workers per slot, stops + cleans workers whose issue left active states. Linear STATE drives everything (Backlog=untouched, Todo→In Progress=start, In Progress=resume, Human Review=read-only PR-comment polling, Rework=full reset, Merging=land skill, Done=shut down). Agent self-transitions via MCP `linear_graphql` tool + maintains the `## Codex Workpad` comment.
- **Gap:** API surface reusable, but control model inverted. Demote local `phases[]`; make Linear states the live driver (constrained polled enum). Build the poll/claim/dispatch/retry orchestrator KS lacks. Replace mediated `/ks:linear` with MCP `linear_graphql` + per-workspace `--mcp-config` (autonomous self-transition — KS never lets the workflow change status autonomously). Add Workpad scratchpad. Recast phase-gated update posts (3/5/6/7) + human approval gates into Linear-state semantics.

### 7.2 agent-runtime — BLOCKER
- **Current:** Agents = Claude Code sessions launched by shell/TS bootstrap (`claude-ks` / `claude-ks-serena`). Interactive, human-driven. `/ks:project-manager` = conductor that spawns short-lived subagents (codebase-locator/analyzer/pattern-finder, plan-analyzer, parallel implementation subagents max 5, architect, code-review) via in-session Task mechanism. One phase = one turn-bounded unit; orchestrator + subagents share one CLI session; only orchestrator commits; pauses at every phase boundary for approval. Multi-turn continuity via handoff docs + `state.yaml` re-read. No poll loop, no concurrency scheduler, no per-issue worker lifecycle.
- **Symphony:** Long-running autonomous orchestrator daemon. Polls Linear every `interval_ms`, claims issues (internal `Unclaimed→Claimed→Running→RetryQueued→Released`), dispatches up to `max_concurrent_agents` workers over App-Server Protocol (JSON-RPC 2.0 over stdio/WebSocket). symphony-claude: `claude -p --output-format stream-json --verbose --resume --mcp-config`, prompt via stdin. Bounded by `max_turns` (default 20), `turn_timeout_ms` (1hr), `stall_timeout_ms`; retried with exponential backoff. Fully unattended (`approval_policy: never`, `sandbox: workspace-write`). Cost tracked per-token into `turn/completed`. Lifecycle hooks wrap each attempt.
- **Gap:** Architecturally opposed. Discard interactive launchers + conductor model; adopt symphony-claude adapter. The 10-phase single-session conductor+subagent topology has no analog (Symphony has no in-session fan-out — each issue is one resumable worker). Per-phase human gates conflict with `approval_policy: never`. Build retry/backoff/stall/turn-limit handling + per-token cost tracking KS never had. Wire Serena + code-review into MCP config. Stop/SubagentStop quality hooks + Neon PreToolUse guard have no place in the unattended app-server loop.

### 7.3 state-machine — BLOCKER
- **Current:** Explicit file-backed phase state machine in `state.yaml`, schema-validated. Unit = each `phases[]` entry, enum `NOT_STARTED → IN_PROGRESS → COMPLETED | SKIPPED` (+ runtime-only `REVISITING`, `INVALIDATED`). Phases 1–8 carry `started_at`/`ended_at`; phases 9–10 use `iterations[]` (length drives `implementation-plan-{NN}.md`). Two re-entry mechanics: Revisit (mark earlier phase REVISITING, cascade downstream INVALIDATED) + Iteration (append to `iterations[]`). Linear `status` is a free-form mirror, NOT driven. Advanced by conductor under human gates; cross-session continuity via handoff docs.
- **Symphony:** TWO orthogonal layers, neither a persisted phase array. (1) Orchestrator-internal lifecycle (in-memory `running`/`retry_attempts` maps, `Unclaimed→…→Released`) — ephemeral, not user-visible, about dispatch/concurrency/retry. (2) Workflow-defined handoff states living in the Linear tracker (Backlog/Todo/In Progress/Human Review/Rework/Merging/Done) — the **real** progression, transitioned by the AGENT via tracker tools per the Jinja2 routing table. Intra-ticket granularity tracked in the single `## Codex Workpad` comment, not a schema.
- **Gap:** No representation in Symphony — state collapses to autonomous agent-driven Linear statuses + Markdown workpad, discarding the schema, 10-phase pipeline, Revisit/Invalidate cascade, iteration versioning, per-phase human approval. Rebuild outside Symphony's model = ground-up; autonomy-vs-human-gate inversion conflicts at the core.

### 7.4 hooks-and-quality-gates — HARD
- **Current:** Quality via Claude Code lifecycle hooks in `plugins/ks/hooks/hooks.json`, fired by the local session. Five bindings:
  1. `SessionStart` → `code-review-graph status`
  2. `PostToolUse` on Edit|Write|Bash → `code-review-graph update --skip-flows` (keep knowledge graph fresh)
  3. `PreToolUse` on `mcp__Neon__.*` → `protect-neon-branch.sh` (hard-deny ops against protected branch `br-round-breeze-217777`)
  4. `Stop` + 5. `SubagentStop` → same ordered, **blocking** quality trio: `quality-format.sh` (prettier --write then --check, `exit 2` blocks), `quality-lint.sh` (eslint --fix w/ `KS_SORT_IMPORTS` then re-check, `exit 2` blocks), `quality-typecheck.sh` (temp tsconfig scoped to changed files, `tsc --noEmit`, filtered errors `exit 2` block). All source `quality-files.sh` (scope to changed `.ts/.tsx` via union of staged/unstaged/untracked + `git diff main...HEAD`).
  - Plus human-driven gates: read-only `/ks:architect` (grades AC-N, loops NEEDS REVISION until APPROVED, REJECTED pauses) + post-PR `/code-review:code-review`.
- **Symphony:** **No** harness lifecycle hooks for quality gating. Its `hooks:` block = workspace-lifecycle shell scripts only (`after_create` fatal-on-fail, `before_run` aborts-attempt-on-fail, `after_run` logged+ignored, `before_remove` logged+ignored), all via `sh -lc`, single `timeout_ms` (default 60000), cwd=workspace. No PostToolUse/Stop/SubagentStop/PreToolUse equivalents. Quality lives INSIDE the agent's turn loop, mandated by the Jinja2 prompt + the Workpad `### Validation` checklist + the `Merging` state's land-skill loop. No exit-2 blocking, no auto format/lint/typecheck on turn boundaries, no per-tool deny.
- **Gap:** Discard `hooks.json` for the Symphony run path (`claude -p` headless mode never fires interactive hooks — silently inert). Rebuild every gate elsewhere: (a) format/lint/typecheck → `before_run`/`after_run` or prompt Validation commands (lose auto non-bypassable exit-2 + changed-files scoping); (b) `code-review-graph` continuous indexing → `after_run` or drop (no PostToolUse home); (c) **Neon PreToolUse deny → genuine safety regression**, no per-tool interception, must enforce out-of-band; (d) architect loop + post-PR review map to Human Review state but lose deterministic exit-2 / loop-until-APPROVED enforcement.

### 7.5 human-in-loop-granularity — BLOCKER
- **Current:** Synchronous, gate-heavy. `/ks:project-manager` explicitly "not autonomous" — asks which phase, asks before+after each of 10 phases, confirms every Linear update before posting, requires ExitPlanMode approval before any code (Phase 9, zero source edits until approved), surfaces analyzer questions via AskUserQuestion (Phase 10), pauses for manual verification before committing EACH phase. Architect gate mandatory+blocking: NEEDS REVISION loops until APPROVED; REJECTED pauses for explicit decision where literal `override approved` is the only escape. Granularity = per-phase, per-checkpoint, in-session, conversational.
- **Symphony:** Autonomous-by-default, coarse tracker-mediated HITL — NOT interactive/per-tool. `approval_policy: never`, `thread_sandbox: workspace-write`; no mid-turn confirmation, no per-file/command approval, no chat channel. SPEC: approval/user-input "implementation-defined", "runs must not stall indefinitely". Blog: "Never ask a human to perform follow-up actions." Only checkpoints = async Linear state moves (Backlog untouched / self-route to Human Review → read-only PR-comment polling / human → Rework=full reset / Merging=land loop / Done=shut down). Granularity = per-issue, per-state, asynchronous.
- **Gap:** Philosophically inverted. Essentially every KS gate discarded or re-expressed: conversational "which phase / ready / mark COMPLETED" gates have no home; ExitPlanMode plan approval conflicts with workspace-write autonomy (re-model as self-routed Human Review + Linear approve); per-phase pre-commit verification cannot exist (agent commits/pushes/PRs unattended); architect REJECTED→`override approved` interactive escape → self-route to Human Review + human → Rework (loses synchronous in-room override). 9 checkpoints → ~3 async states. Architect blocking-loop + code-review survive as in-turn tools, but the HUMAN gates around them can't stay synchronous.

### 7.6 workspace-isolation — MODERATE
- **Current:** git worktrees created OUTSIDE Claude by bootstrap scripts (`ks-start-project`/`ks-start-ticket` → `create-worktree`). One worktree per project/ticket, path in `worktree_dir` in `state.yaml` at `workflow/{username}/{slug}/`. Durable home for `state.yaml`, `resources/` (codebase-research, implementation-plan-NN, handoffs/). Human-seeded, persistent across sessions (handoffs let fresh Claude resume), Neon DB isolation enforced reactively by PreToolUse hook. No auto-provisioning loop, no concurrency cap, no automated teardown.
- **Symphony:** Auto-provisions one workspace per issue, unattended, inside the poll loop. `workspace.root` + sanitized issue identifier (non-`[A-Za-z0-9._-]` → `_`). Creation triggers `after_create` (e.g. `git clone --depth 1 … && mise deps.get`, fatal on fail). `before_run`/`after_run`/`before_remove` bracket each attempt (`timeout_ms` default 60000, cwd=workspace, `sh -lc`). Auto teardown on terminal tracker state. Workspace fingerprint `<hostname>:<abs-path>@<short-sha>` written to Workpad. Concurrency = `max_concurrent_agents` (default 10) + per-state caps.
- **Gap:** Primitive matches conceptually, but lifecycle ownership inverts (human-script-created+manual-teardown → orchestrator auto-create/destroy keyed off Linear state). Discard `ks-start-*` bootstrap; use `workspace.root` + identifier scheme + `after_create` clone. Re-express setup (pnpm install, env) as hooks under `timeout_ms` (**monorepo pnpm install likely exceeds 60s — bump**). KS quality Stop/SubagentStop + Neon PreToolUse hooks are Claude-harness hooks, orthogonal to Symphony workspace hooks. Add Workpad fingerprint convention. ⚠️ auto-teardown on terminal state would destroy the worktree KS deliberately keeps for resumable handoffs.

---

## 8. Open caveats from research
- OpenAI announcement page (`openai.com/index/open-source-codex-orchestration-symphony/`) returned **HTTP 403** to the fetcher — direct OpenAI quotes are from secondary coverage.
- Default model string (`gpt-5.5`) and a "Kata CLI / v1.1.0 model-agnostic" claim came from single search snippets — **confirm against the live repo** before relying on them.
- `symphony-claude` is a **community fork**, not officially supported; verify it tracks the current Codex app-server protocol version.

## 9. Sources
- `github.com/openai/symphony` — SPEC.md, `elixir/WORKFLOW.md`
- `sapsaldog.com/posts/symphony-with-claude-code` — symphony-claude adapter
- `github.com/Citedy/codex-symphony` — portable bootstrap fork
- tessl.io, InfoWorld, Help Net Security, Digital Applied — secondary coverage
