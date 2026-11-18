// Tests for lib/ksconfig.ts — the shared KS store layer under <dataDir>/.env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandHome, storeValues } from './ksconfig.js';

function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ksflow-ksconfig-'));
  const kc = join(dir, 'kc');
  mkdirSync(kc);
  mkdirSync(join(dir, 'config'));
  const bin = join(dir, 'security');
  writeFileSync(
    bin,
    `#!/bin/bash\ns=; a=; while [ $# -gt 0 ]; do case $1 in -s) s=$2; shift;; -a) a=$2; shift;; esac; shift; done\nf="${kc}/\${s}__\${a}"; [ -f "$f" ] || exit 44; cat "$f"\n`,
  );
  chmodSync(bin, 0o755);
  return { dir, kc, configDir: join(dir, 'config'), securityBin: bin };
}

test('tokens come from the Keychain and plain values from <ns>.env', () => {
  const f = fixture();
  writeFileSync(join(f.kc, 'ks.slack__SLACK_TOKEN'), 'xoxp-kc');
  writeFileSync(join(f.configDir, 'gcs.env'), 'GCS_BUCKET=my-bucket\n');
  const v = storeValues({}, { configDir: f.configDir, securityBin: f.securityBin });
  assert.equal(v.SLACK_TOKEN, 'xoxp-kc');
  assert.equal(v.GCS_BUCKET, 'my-bucket');
  assert.equal(v.LINEAR_API_KEY, undefined);
});

test('anything already set (real env or <dataDir>/.env) wins', () => {
  const f = fixture();
  writeFileSync(join(f.kc, 'ks.slack__SLACK_TOKEN'), 'xoxp-kc');
  const v = storeValues({ SLACK_TOKEN: 'xoxp-data-env' }, { configDir: f.configDir, securityBin: f.securityBin });
  assert.equal(v.SLACK_TOKEN, undefined);
});

test('no store at all is not an error', () => {
  assert.deepEqual(storeValues({}, { configDir: '/nonexistent', securityBin: '/nonexistent/security' }), {});
});

test('expandHome: ~/…, $HOME/… and ${HOME}/… get the home folder; nothing else changes', () => {
  const h = '/Users/x';
  assert.equal(expandHome('~', h), h);
  assert.equal(expandHome('~/karmasuite/karmasuite', h), '/Users/x/karmasuite/karmasuite');
  assert.equal(expandHome('$HOME/git/claude-memory', h), '/Users/x/git/claude-memory');
  assert.equal(expandHome('${HOME}/git/ks', h), '/Users/x/git/ks');
  assert.equal(expandHome('/abs/path', h), '/abs/path');
  assert.equal(expandHome('~other/x', h), '~other/x');
  assert.equal(expandHome('$HOMEDIR/x', h), '$HOMEDIR/x');
});
