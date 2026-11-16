/// One board for several devices (src/lib/db/types.ts DeviceDoc, SettingsDoc,
/// MasterRequestDoc): `devices` (one row per device, keyed by its id),
/// `meta` (key `settings`: the shared settings and masterDeviceId) and
/// `master_requests`. PocketBase is one device's local store, so these hold
/// that device alone; the shapes match Firestore's devices/{id},
/// meta/settings and masterRequests/{uid}. A collection that already exists
/// is left as it is.
migrate(
  (app) => {
    const ensure = (name, fields, indexes) => {
      try {
        app.findCollectionByNameOrId(name);
        return;
      } catch (_) {
        // missing: create it below
      }
      app.save(
        new Collection({
          type: 'base',
          name,
          listRule: '',
          viewRule: '',
          createRule: '',
          updateRule: '',
          deleteRule: '',
          fields,
          indexes,
        }),
      );
    };
    ensure(
      'devices',
      [
        { type: 'text', name: 'key', required: true, max: 255 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      ['CREATE UNIQUE INDEX idx_devices_key ON devices (key)'],
    );
    ensure(
      'meta',
      [
        { type: 'text', name: 'key', required: true, max: 255 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      ['CREATE UNIQUE INDEX idx_meta_key ON meta (key)'],
    );
    ensure(
      'master_requests',
      [
        { type: 'text', name: 'uid', required: true, max: 255 },
        { type: 'text', name: 'createdAt', max: 64 },
        { type: 'json', name: 'data', maxSize: 2000000 },
      ],
      ['CREATE UNIQUE INDEX idx_master_requests_uid ON master_requests (uid)'],
    );
  },
  (app) => {
    for (const name of ['devices', 'meta', 'master_requests']) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {
        // already gone
      }
    }
  },
);
