---
name: Review Changes
description: Perform a structured, risk-aware code review of the current changes
---

## Review Changes

Perform a thorough, risk-aware code review of the working-tree or PR changes.

### Steps

1. Run `git diff` (or `git diff main...HEAD`) to enumerate changed files and hunks.
2. For each changed file, read the surrounding code to understand intent and blast radius.
3. For each high-risk change, locate the corresponding tests and check coverage.
4. Trace consumers of modified exports (`Grep` for callers) to assess downstream impact.
5. For any untested changes, suggest specific test cases.

### Output Format

Provide findings grouped by risk level (high/medium/low) with:
- What changed and why it matters
- Test coverage status
- Suggested improvements
- Overall merge recommendation

## Frontend Verification (conditional, Playwright CLI)

**Condition**: run this section ONLY when the diff touches `apps/www/src/client/**` or `packages/react-components/**`. Skip otherwise.

### Prerequisites

1. Confirm dev server is up:
   ```bash
   curl -fsS -o /dev/null http://localhost:3000
   ```
   On non-zero exit, emit `BLOCKED: dev server not running on :3000` and SKIP the browser steps (continue with non-browser review).

2. Ensure Playwright Chromium is installed (idempotent, cached):
   ```bash
   pnpm dlx playwright@latest install chromium
   ```

3. `mkdir -p /tmp/ks-review`.

### Per affected route

For each route reachable from the changed file (infer from the file path), do:

1. **Screenshot**:
   ```bash
   pnpm dlx playwright@latest screenshot \
     --browser=chromium \
     --wait-for-timeout=2000 \
     --viewport-size=1440,900 \
     "http://localhost:3000/${route}" \
     "/tmp/ks-review/${slug}.png"
   ```
   Read the PNG via the multimodal `Read` tool. Cite visible regressions or improvements.

2. **Console error scrape**:
   ```bash
   pnpm dlx playwright@latest eval \
     --browser=chromium \
     "http://localhost:3000/${route}" \
     "JSON.stringify(window.__consoleErrors ?? [])" \
     > "/tmp/ks-review/${slug}.console.json"
   ```
   Read the JSON. Surface any error-level entries.

   If the app does not capture `window.__consoleErrors`, treat absence as `SKIPPED: console capture not wired` rather than a failure.

3. If route cannot be resolved, emit `SKIPPED: route unresolved for <file>` and continue.

### Browser verification block (appended to output)

```
## Browser verification

| Route | Screenshot | Console errors |
|-------|------------|----------------|
| /funds/reporting | /tmp/ks-review/funds-reporting.png | 0 |
| /budget/categories | /tmp/ks-review/budget-categories.png | 2 (see findings) |
```

Console errors raise the affected route's risk level: any error-level entry bumps the change at least to medium risk; a thrown exception bumps to high.
