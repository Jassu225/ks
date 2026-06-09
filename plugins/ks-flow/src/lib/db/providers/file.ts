// lib/db/providers/file.ts — FUTURE provider (v2), documented slot only.
//
// Planned shape:
//   writer = atomic JSON writes under $CLAUDE_PLUGIN_DATA (one file per
//            project, debounced like the Firestore writer).
//   source = fs.watch via a tiny local read endpoint owned by this provider
//            (the browser can't read local disk directly), polled by the board.
//
// Not implemented in v1. createProvider() throws for db_provider="file".
export {};
