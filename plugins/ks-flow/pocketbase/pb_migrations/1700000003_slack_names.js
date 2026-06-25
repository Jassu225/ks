/// ks-flow `slack_names` collection (auto-applied by `pocketbase serve --migrationsDir`).
//
// A workspace-global cache of Slack id → name, populated lazily when the Notes page
// resolves mentions: user IDs (`U…`, from <@U…>) and channel IDs (`C…`, from <#C…>).
// Keyed by `uid` (the Slack id); `name` is the bare name (display name for a user,
// channel name without the leading #). Not project-scoped — the same id maps to the
// same name across projects. Rules are public ("") because PocketBase binds to
// 127.0.0.1 for a single local user.
migrate(
  (app) => {
    const c = new Collection({
      type: 'base',
      name: 'slack_names',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      deleteRule: '',
      fields: [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'name', max: 255 },
      ],
      indexes: ['CREATE UNIQUE INDEX idx_slack_names_uid ON slack_names (uid)'],
    });
    app.save(c);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId('slack_names'));
    } catch (_) {
      // already gone
    }
  },
);
