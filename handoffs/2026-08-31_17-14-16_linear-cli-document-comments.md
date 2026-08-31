---
date: 2026-08-31T17:14:16+05:30
git_commit: fd4ebe4
branch: main
task: Add document-comment read/write support to the linear CLI
---

# Handoff: Document comments in the `linear` CLI

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

A peer session was blocked reading review feedback on a Linear document: `linear comment list <document-id>` fails with `Issue not found`, and `document get --json` returns `content` but no comments. The CLI had no way to reach document comments at all.

Confirmed the data model from the shipped `@linear/sdk` v29 typings (generated from the API schema, so authoritative — not from guesswork):

- `Comment.documentContent?: DocumentContent` — a comment associates with the document's **content row**, not the `Document` row.
- `CommentCreateInput.documentContentId` exists; there is no `documentId`. Writes need `Document.documentContentId`.
- `CommentFilter.documentContent` → `DocumentContentFilter.document` — the comments connection can be narrowed to a document.
- `Document.comments: CommentConnection`, exposed on the SDK class as `document.comments(vars)`. This is the simplest read path: a document id or slugId is enough, no need to resolve `documentContentId` first.
- Threads exist: `Comment.parent` / `Comment.children`, and `CommentCreateInput.parentId` to reply.

Added two commands in `plugins/ks/scripts/linear-cli.ts`, nested under `document` (the existing `comment list <issue>` takes an issue positionally, so it could not be overloaded):

```
linear document comment list <id-or-slug> [-j|--json]
linear document comment create <id-or-slug> <body> [--parent <commentId>] [-j|--json]
```

Both accept the document UUID or the slugId. Output follows the existing `comment list` conventions (cyan author, date, indented body, `-j` for JSON) and adds `url`, `quotedText` (inline comments), `editedAt`, `resolvedAt`, and nested `replies[]`.

Verified against real data. Reading document `25bcdf87-5cd4-4135-b39f-51f9c60aa1ba` returns its one inline comment (author, date, and the `quotedText` it is anchored to). Create and threading were verified on a throwaway document that was created and then trashed — root comment, then a `--parent` reply, listed back correctly nested. Nothing was posted to the peer's review document.

## Key Decisions Made

- **Nested the commands under `document`, not `comment`.** `comment list|create` take an issue as their first positional. Adding a `--document` flag would have made the positional conditionally required; a `document comment ...` subgroup keeps both surfaces unambiguous and discoverable from `document --help`.
- **Read through `Document.comments()` rather than `client.comments({ filter: { documentContent: ... } })`.** Same data, but the document id/slug is already in hand and no `documentContentId` lookup is needed.
- **Build the thread tree from children, not parents.** A comment's `parent` is only reachable through an extra fetch (the id sits in a private `_parent` field), so the code asks each comment for its children and treats anything that is nobody's child as a thread root. Costs N+1 requests, but uses only public API and handles nesting deeper than one level.
- **Did not refactor the four existing inline `client.document()` try/catch blocks** onto the new `findDocument()` helper. A peer session had a branch mid-review, so the diff was kept additive.

## Deviations from Plan

Two API behaviours forced a rewrite of the first implementation. Both surface as the *same* misleading error, `Entity not found: Comment: could not find by hash - Could not find referenced comment.`, which makes them easy to misattribute:

1. `document.comments({ filter: { parent: { null: true } } })` is **rejected server-side**, even though `NullableCommentFilter.null` is in the schema. There is no roots-only query; fetch the flat connection and partition client-side.
2. `Comment.children()` does **not** inject its own id into the query — the SDK sends `comment(hash: null, id: null, ...)`. It must be called as `comment.children({ id: comment.id })`. Any other `.children()` call site would hit the same bug.

Both are documented in comments at the call sites.

## Uncommitted Changes

None — committed and pushed to `jassu` then `origin`.

Files touched:
- `plugins/ks/scripts/linear-cli.ts` — new document comment commands and helpers
- `plugins/ks/commands/linear.md` — `/ks:linear` docs for the new commands
- `plugins/ks/scripts/README.md` — CLI reference entry plus the issue-vs-document comment note

## Known Issues

- `plugins/ks/scripts/quality-lint.sh` fails with `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE` — it points at the karmasuite workspace, not this repo. Pre-existing and unrelated to this change. `npx tsc --noEmit -p plugins/ks/scripts/tsconfig.json` is clean.
- Listing is one request per comment (children lookup). Fine for review-sized threads; would need the private `_parent` field or a raw GraphQL query to collapse into one round trip.
- No pagination handling: the default connection page size applies to both the comment list and each children fetch. A document with more comments than one page would silently truncate.
- No `document comment update|delete` — read and create only, which is what the blocked session needed.

## Resume Point

Nothing is blocked. If picking this up further:

- Sanity check the shipped commands:
  ```bash
  linear document comment list 25bcdf87-5cd4-4135-b39f-51f9c60aa1ba --json
  ```
- To add pagination, both `document.comments()` and `comment.children({ id })` accept `first`/`after`; loop on `pageInfo.hasNextPage` in `listDocumentComments` in `plugins/ks/scripts/linear-cli.ts`.
- To collapse the N+1, replace the children walk with a single `client.comments({ filter: { documentContent: { document: { id: { eq: document.id } } } } })` and read each node's parent id — but note the SDK only exposes it privately, so this trades the round trips for reaching into SDK internals.
- If `update`/`delete` are ever needed, `Comment.update(input)` and `Comment.delete()` do inject `this.id` correctly (unlike `children()`), so they are straightforward.
