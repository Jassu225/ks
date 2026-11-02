/// ks-flow Briefing collections (auto-applied by `pocketbase serve --migrationsDir`).
//
// `briefing_items`: what the master session found in Slack for the person, one
// record per Slack message (uid = itemUid(key)). `briefing_runs`: one record
// per master pass over Slack, written running and completed by `run finish`.
// `daily_logs`: one record per local day (uid = 'YYYY-MM-DD'), the log-in and
// log-off reports. `master_events`: one record per thing done to the master in
// the background (the daemon starting / restarting it, a request file written
// or dropped by the daemon or the board) — the Activity Log's master rows.
// See docs/briefing.md.
//
// All follow the reminders convention: identified by a `uid` field, the full
// doc in `data`, `projectKey` and a few fields mirrored out so reads filter and
// sort server-side — an item's key, groupKey (one card per thread), status,
// dueAt and archivedAt ('' while open: the board loads recently archived items
// by it); a run's startedAt; a log's date; an event's at. Rules are public ("") because
// PocketBase binds to 127.0.0.1 for a single local user.
migrate(
  (app) => {
    const items = new Collection({
      type: 'base',
      name: 'briefing_items',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'key', max: 255 },
        { type: 'text', name: 'groupKey', max: 255 },
        { type: 'text', name: 'status', max: 32 },
        { type: 'text', name: 'dueAt', max: 64 },
        { type: 'text', name: 'archivedAt', max: 64 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_briefing_items_project_uid ON briefing_items (projectKey, uid)',
        'CREATE INDEX idx_briefing_items_project_status ON briefing_items (projectKey, status)',
        'CREATE INDEX idx_briefing_items_project_group ON briefing_items (projectKey, groupKey)',
        'CREATE INDEX idx_briefing_items_project_archived ON briefing_items (projectKey, archivedAt)',
      ],
    });
    app.save(items);

    const runs = new Collection({
      type: 'base',
      name: 'briefing_runs',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'startedAt', max: 64 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      indexes: [
        'CREATE UNIQUE INDEX idx_briefing_runs_uid ON briefing_runs (uid)',
        'CREATE INDEX idx_briefing_runs_project_started ON briefing_runs (projectKey, startedAt)',
      ],
    });
    app.save(runs);

    const daily = new Collection({
      type: 'base',
      name: 'daily_logs',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'projectKey', max: 255 },
        { type: 'text', name: 'date', max: 16 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      indexes: ['CREATE UNIQUE INDEX idx_daily_logs_project_uid ON daily_logs (projectKey, uid)'],
    });
    app.save(daily);

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
  (app) => {
    for (const name of ['master_events', 'daily_logs', 'briefing_runs', 'briefing_items']) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {
        // already gone
      }
    }
  },
);
