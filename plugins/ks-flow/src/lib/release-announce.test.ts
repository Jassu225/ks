import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcePatch, marketplaceVersions, newerAnnounced } from './release-announce.js';

test('marketplaceVersions reads name → version', () => {
  const json = JSON.stringify({ plugins: [{ name: 'ks', version: '1.2.2' }, { name: 'ks-flow', version: '0.4.1' }, { name: 'x' }] });
  assert.deepEqual(marketplaceVersions(json), { ks: '1.2.2', 'ks-flow': '0.4.1' });
  assert.deepEqual(marketplaceVersions('not json'), {});
});

test('announcePatch only goes up', () => {
  assert.deepEqual(announcePatch(null, { ks: '1.2.2' }), { ks: '1.2.2' });
  assert.equal(announcePatch({ ks: '1.2.2' }, { ks: '1.2.2' }), null, 'same: nothing');
  assert.equal(announcePatch({ ks: '1.2.10' }, { ks: '1.2.9' }), null, 'lower: nothing');
  assert.deepEqual(announcePatch({ ks: '1.2.1', 'ks-flow': '0.4.1' }, { ks: '1.2.2', 'ks-flow': '0.4.0' }), {
    ks: '1.2.2',
    'ks-flow': '0.4.1',
  });
});

test('newerAnnounced compares with the installed versions', () => {
  const ann = { ks: '1.2.2', 'ks-flow': '0.4.1', 'ks-master': '0.2.0' };
  assert.deepEqual(newerAnnounced(ann, { ks: '1.2.1', 'ks-flow': '0.4.1', 'ks-master': null }), [
    { plugin: 'ks', installed: '1.2.1', announced: '1.2.2' },
  ]);
  assert.deepEqual(newerAnnounced(null, { ks: '1.0.0' }), []);
});
