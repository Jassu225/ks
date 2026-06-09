/// ks-flow PocketBase schema (auto-applied by `pocketbase serve --migrationsDir`).
//
// Three base collections mirror the provider-agnostic doc shapes
// (ProjectDoc / WorkUnitDoc / SessionDoc). The full doc is stored verbatim in
// the `data` json field; `key` is our own id (projectId / unitId / sessionId),
// uniquely indexed so the daemon can upsert. `projectKey` + `inProject` exist
// only so the board can filter server-side. API rules are public ("") because
// PocketBase binds to 127.0.0.1 for a single local user — no auth dance.
migrate(
  (app) => {
    const make = (name) =>
      new Collection({
        type: 'base',
        name,
        listRule: '',
        viewRule: '',
        createRule: '',
        updateRule: '',
        deleteRule: '',
        fields: [
          { type: 'text', name: 'key', required: true, max: 255 },
          { type: 'text', name: 'projectKey', max: 255 },
          { type: 'bool', name: 'inProject' },
          { type: 'bool', name: 'archived' },
          { type: 'json', name: 'data', maxSize: 2000000 },
        ],
        indexes: [`CREATE UNIQUE INDEX idx_${name}_key ON ${name} (key)`],
      });
    app.save(make('projects'));
    app.save(make('work_units'));
    app.save(make('sessions'));
  },
  (app) => {
    for (const name of ['projects', 'work_units', 'sessions']) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {
        // already gone
      }
    }
  },
);
