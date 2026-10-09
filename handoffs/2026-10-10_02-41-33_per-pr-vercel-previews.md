---
date: 2026-10-10T02:41:33+05:30
git_commit: e210869
branch: main
task: Move the Vercel preview from one Preview Deploy section (and a statusline pill) onto each PR row of the /ks-project pane
---

# Handoff: Per-PR Vercel previews in the project pane

> See CLAUDE.md for dev guidance and plugins/ks/README.md ("Project pane") for the pane as it now stands.

## What Happened
Each PR gets its own Vercel preview, so the pane's single **PREVIEW DEPLOY** section (the preview of the latest PR's branch) was removed. Each PR row in **PULL REQUESTS** now reads: GitHub and review links on line one, then the preview pill with `open preview` and `build logs`, then the PR's date (dimmed). The Branch and Build rows (branch name, short SHA, build time, checked time) are gone. The statusline's `▲ PREVIEW` pill was removed too.

- `hooks/register.tsx`: `loadPreview` became `loadPreviews`. It calls `list_deployments` for each distinct PR branch in parallel and stores the results in `ks.previewDeploys`, a map from branch to `PreviewDeploy`. The PR rows read their own branch's entry.
- `types/index.d.ts`: the state key `previewDeploy: PreviewDeploy | null` became `previewDeploys: Record<string, PreviewDeploy> | null`.
- `hooks/live/vercel.ts`: removed `previewBranch` and `SHARED_BRANCHES`. Both fed the fallback to the checked-out branch, which is gone.
- `hooks/live/live.test.ts`: the end-to-end tests now open the pane and check the preview under the PR row (keys `pr-preview-<n>`, `pr-logs-<n>`). They also check that the statusline shows no `▲` and that nothing is fetched while the pane is closed.

## Key Decisions Made
- **Fetch only while the pane is open**: with the statusline pill gone, nothing else needs the preview. Opening the pane fetches right away (`openPane` triggers the `previewDeploys` job). A `git push` triggers a fetch only when the pane is open.
- **No fallback to the checked-out branch**: a ticket with no PRs shows no preview, and neither does a PR whose `state.yaml` entry has no `branch`.
- If any branch's call fails, the whole map is cleared. The same rules as before apply: no server means stop for the session, a refusal means try again at the next interval.

## Deviations from Plan
None.

## Uncommitted Changes
None after the docs commit (README, CLAUDE.md, this handoff).

## Known Issues
- Not yet checked in a live `claude-ks` session. Only the plugin tests (26/26), `claude plugin validate` and `tsc` ran.
- Each pane poll makes one `list_deployments` call per PR branch: fine for a few PRs, but it grows with stacked PRs.
- The pane's preview pill has no link of its own. The links beside it cover that, as the old section did.

## Resume Point
Open a ticket checkout with PRs in `claude-ks`, run `/ks-project`, and confirm each PR row shows its own pill and links (check `KAR-13030`, which has PRs #6735 and #6739). To change it, start at the PR rows in `register.tsx`: search for `pr-deploy-`.
