---
description: Generate boilerplate from manifest-driven templates for tRPC router / engine / AG Grid. Pulls canonical files live from $KS_PROJECT_ROOT_PATH. Trigger - scaffold, ks:scaffold, generate boilerplate.
allowed-tools: Read, Write, Glob, Bash, AskUserQuestion
---

# /ks:scaffold

Generate boilerplate from manifest-driven templates by reading canonical
files live from the karmasuite repo, applying replacements, and writing
the result into the target location. The canonical evolves → the scaffold
evolves. No `.tmpl` duplication.

## Arguments

```
ARGUMENTS: <topology> <name>
```

- `<topology>` — one of `trpc`, `engine`, `ag-grid`.
- `<name>` — domain name. Accepts camelCase or PascalCase; both `{{name}}`
  (camelCase) and `{{Name}}` (PascalCase) variants are derived automatically.

## Environment

- `$KS_PLUGIN_DIR` — set by `init`. Points at this plugin's root. Used to
  resolve `$KS_PLUGIN_DIR/templates/{topology}/manifest.yaml`.
- `$KS_PROJECT_ROOT_PATH` — set by `init`. Points at the karmasuite repo
  root. Used to resolve `canonical_root` (read) and `output_root` (write).

If `$KS_PROJECT_ROOT_PATH` is unset, abort with:
```
$KS_PROJECT_ROOT_PATH not set. Run the plugin init script to configure it.
```

## Flow

1. **Validate `<topology>`.** Must be one of `trpc`, `engine`, `ag-grid`.
   If missing or invalid, use `AskUserQuestion` to prompt for the topology.

2. **Read the manifest.** Path: `$KS_PLUGIN_DIR/templates/{topology}/manifest.yaml`.
   Parse as YAML. On missing file, abort with:
   ```
   Unknown topology: <topology>. Available: trpc, engine, ag-grid.
   ```

3. **Derive placeholder variants.**
   - `{{name}}` = camelCase form of `<name>` (first char lower).
   - `{{Name}}` = PascalCase form of `<name>` (first char upper).

4. **Resolve output paths.** Substitute `{{name}}` and `{{Name}}` into the
   manifest's `output_root` and `test_output_root` to get absolute paths
   under `$KS_PROJECT_ROOT_PATH`.

5. **Preflight: abort on conflicts.** For every (source → target) pair in
   `files` and `test_files`, compute the absolute target path. If ANY
   target already exists, list every conflict and abort BEFORE writing
   anything. No partial scaffolds.

6. **Read canonical, apply replacements, write target.** For each pair:
   - Read `$KS_PROJECT_ROOT_PATH/{canonical_root}/{from}` (or
     `{test_canonical_root}/{from}` for test files).
   - Apply each `replacements` entry to the file body top-to-bottom.
   - Substitute `{{Name}}` and `{{name}}` in the target filename.
   - Write to the absolute target path.

7. **Print `post_steps`.** Render the manifest's `post_steps` as a
   checklist for the user to complete.

8. **Reminder.** Tell the user the generated code is a starting point —
   Vitest tests will fail until real fixtures replace the placeholders.

## Failure Modes

| Trigger | Behavior |
| ------- | -------- |
| `$KS_PROJECT_ROOT_PATH` unset | Abort with init reference. |
| Manifest missing | `Unknown topology: <topology>. Available: trpc, engine, ag-grid.` |
| Canonical source missing | `Canonical source <path> not found; manifest may be stale.` |
| Target exists | Abort BEFORE writing anything. List every conflict. |
| YAML parse error | Surface the parser error verbatim with the manifest path. |

## Example

```
/ks:scaffold trpc widgets
```

Reads `apps/www/src/server/api/routers/costCenters/*` from
`$KS_PROJECT_ROOT_PATH`, transforms `costCenters` → `widgets` and
`CostCenter` → `Widgets` (PascalCase derived from `widgets`), writes the
result to `apps/www/src/server/api/routers/widgets/` under the project
root, and prints the post-steps checklist (wire into root.ts, add real
Zod schemas, replace seedData fixtures).
