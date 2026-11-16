// Run: node --import tsx --test lib/env.spec.ts
// The config lookup order (lib/env.ts, mirrored by lib/ks-config.sh):
// real env > KS store (Keychain secrets, ~/.config/ks/<ns>.env) > legacy files.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseEnvFile, readKeys, storeValues, type KsKey } from './env.js'

const KEYS: KsKey[] = [
  { namespace: 'linear', key: 'LINEAR_API_KEY', secret: true },
  { namespace: 'slack', key: 'SLACK_TOKEN', secret: true },
  { namespace: 'ks', key: 'KS_PROJECT_ROOT_PATH', secret: false },
]

/** A fake `security` that answers from a folder of <service>__<account> files. */
function fakeSecurity(dir: string): string {
  const kc = join(dir, 'kc')
  mkdirSync(kc, { recursive: true })
  const bin = join(dir, 'security')
  writeFileSync(
    bin,
    `#!/bin/bash
s=; a=; while [ $# -gt 0 ]; do case $1 in -s) s=$2; shift;; -a) a=$2; shift;; esac; shift; done
f="${kc}/\${s}__\${a}"; [ -f "$f" ] || exit 44; cat "$f"
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-env-'))
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  return { dir, configDir, securityBin: fakeSecurity(dir) }
}

test('secrets come from the Keychain, plain values from <ns>.env', () => {
  const f = fixture()
  writeFileSync(join(f.dir, 'kc', 'ks.linear__LINEAR_API_KEY'), 'lin_kc\n')
  writeFileSync(join(f.configDir, 'ks.env'), 'KS_PROJECT_ROOT_PATH="/repo"\n')
  const v = storeValues({}, { configDir: f.configDir, securityBin: f.securityBin, keys: KEYS })
  assert.deepEqual(v, { LINEAR_API_KEY: 'lin_kc', KS_PROJECT_ROOT_PATH: '/repo' })
})

test('the real environment wins over the store', () => {
  const f = fixture()
  writeFileSync(join(f.dir, 'kc', 'ks.linear__LINEAR_API_KEY'), 'lin_kc')
  const v = storeValues({ LINEAR_API_KEY: 'from-env' }, { configDir: f.configDir, securityBin: f.securityBin, keys: KEYS })
  assert.equal(v.LINEAR_API_KEY, undefined)
})

test('a secret is never read from a config file, a plain value never from the Keychain', () => {
  const f = fixture()
  writeFileSync(join(f.configDir, 'slack.env'), 'SLACK_TOKEN=plaintext\n')
  writeFileSync(join(f.dir, 'kc', 'ks.ks__KS_PROJECT_ROOT_PATH'), '/wrong')
  const v = storeValues({}, { configDir: f.configDir, securityBin: f.securityBin, keys: KEYS })
  assert.deepEqual(v, {})
})

test('a missing security binary or config dir yields nothing, not an error', () => {
  const v = storeValues({}, { configDir: '/nonexistent', securityBin: '/nonexistent/security', keys: KEYS })
  assert.deepEqual(v, {})
})

test('parseEnvFile strips quotes and export', () => {
  const f = fixture()
  const file = join(f.dir, 'x.env')
  writeFileSync(file, 'export A=1\nB="two"\n# C=3\n')
  assert.deepEqual(parseEnvFile(file), { A: '1', B: 'two' })
})

test('the shipped key list puts every token in a secret slot', () => {
  const keys = readKeys()
  for (const k of ['LINEAR_API_KEY', 'SLACK_TOKEN', 'GRAIN_API_TOKEN', 'GCS_PRIVATE_KEY']) {
    assert.equal(keys.find((x) => x.key === k)?.secret, true, k)
  }
  assert.equal(keys.find((x) => x.key === 'KS_PROJECT_ROOT_PATH')?.secret, false)
})
