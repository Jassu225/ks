/// ks-flow `reminders` collection (auto-applied by `pocketbase serve --migrationsDir`).
//
// Holds per-card custom reminders + session pause records (discriminated by the
// `data.kind` field). Unlike the older collections (keyed by `key`), reminders
// are identified by a `uid` field — the convention for new doc ids (matches the
// Firestore doc id). The full ReminderDoc lives in `data`; `projectKey`/`unitKey`
// mirror two fields out so the board can filter server-side. Rules are public
// ("") because PocketBase binds to 127.0.0.1 for a single local user.
migrate(
  (app) => {
    const c = new Collection({
      type: 'base',
      name: 'reminders',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'unitKey', max: 255 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_reminders_uid ON reminders (uid)',
        'CREATE INDEX idx_reminders_projectKey ON reminders (projectKey)',
        'CREATE INDEX idx_reminders_unitKey ON reminders (unitKey)',
      ],
    });
    app.save(c);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId('reminders'));
    } catch (_) {
      // already gone
    }
  },
);
