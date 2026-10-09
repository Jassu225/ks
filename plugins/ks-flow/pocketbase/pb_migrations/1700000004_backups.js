/// ks-flow transcript-backup collections (auto-applied by `pocketbase serve --migrationsDir`).
//
// `backup_units`: what the GCS backup holds for each unit (the doc that used to
// be one entry of archive-index.json) — the sweep's cache of the bucket.
// `backup_runs`: one record per sweep, written as it starts and completed as it
// ends — the board's Backups page.
//
// Both follow the reminders convention: identified by a `uid` field, the full
// doc in `data`, `projectKey` mirrored out so reads filter server-side. A unit's
// uid is its object-name-safe identifier, unique within a project; a run's uid
// is a uuid. `startedAt` is mirrored out of a run so the page can sort without
// reading `data`. Rules are public ("") because PocketBase binds to 127.0.0.1
// for a single local user.
migrate(
  (app) => {
    const units = new Collection({
      type: 'base',
      name: 'backup_units',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'json', name: 'data', maxSize: 5000000 },
      ],
      indexes: ['CREATE UNIQUE INDEX idx_backup_units_project_uid ON backup_units (projectKey, uid)'],
    });
    app.save(units);

    const runs = new Collection({
      type: 'base',
      name: 'backup_runs',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'startedAt', max: 64 },
        { type: 'json', name: 'data', maxSize: 5000000 },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_backup_runs_uid ON backup_runs (uid)',
        'CREATE INDEX idx_backup_runs_project_started ON backup_runs (projectKey, startedAt)',
      ],
    });
    app.save(runs);
  },
  (app) => {
    for (const name of ['backup_runs', 'backup_units']) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {
        // already gone
      }
    }
  },
);
