// Tests for lib/pick-datadir.ts: the backfill script finds the configured data dir from anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredDataDirs, pickDataDir } from './pick-datadir.js';

test('pickDataDir: flag, then KS_FLOW_DATA, then the project path option', () => {
  const derive = (cwd: string) => `/derived${cwd}`;
  assert.equal(pickDataDir({ flag: '/x', env: { KS_FLOW_DATA: '/y' }, derive }).dir, '/x');
  assert.equal(pickDataDir({ env: { KS_FLOW_DATA: '/y' }, derive }).dir, '/y');
  assert.equal(pickDataDir({ env: { CLAUDE_PLUGIN_OPTION_project_path: '/repo' }, derive }).dir, '/derived/repo');
});

test('pickDataDir: the cwd project when configured, else the only configured one, else the cwd (ambiguous with several)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ksflow-dd-'));
  const here = join(root, 'here');
  mkdirSync(here);
  const derive = () => here;
  // Not configured here, one configured elsewhere → that one (from any directory).
  assert.deepEqual(pickDataDir({ env: {}, derive, configured: ['/only'] }), { dir: '/only', why: 'the only configured project', ambiguous: false });
  // Several → the cwd's, flagged.
  assert.equal(pickDataDir({ env: {}, derive, configured: ['/a', '/b'] }).ambiguous, true);
  // Configured here → here.
  writeFileSync(join(here, 'project.conf'), '{}');
  assert.equal(pickDataDir({ env: {}, derive, configured: ['/a', '/b'] }).dir, here);
  assert.deepEqual(configuredDataDirs(root), [here]);
});
