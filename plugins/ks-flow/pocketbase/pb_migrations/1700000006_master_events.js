/// `master_events`, for stores where 1700000005_briefing.js was applied before
/// that file gained the collection (PocketBase never re-runs an applied
/// migration, so the edit didn't reach them). A no-op where it already exists:
/// on a fresh store 1700000005 creates it. Same shape as there — see that
/// file's header and docs/briefing.md.
migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId('master_events');
      return; // created by 1700000005
    } catch (_) {
      // missing: create it below
    }
    const events = new Collection({
      type: 'base',
      name: 'master_events',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'at', max: 64 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_master_events_uid ON master_events (uid)',
        'CREATE INDEX idx_master_events_project_at ON master_events (projectKey, at)',
      ],
    });
    app.save(events);
  },
  (_app) => {
    // Nothing: 1700000005's down migration removes master_events.
  },
);
