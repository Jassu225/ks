// Run: node --import tsx --test lib/ks-root.spec.ts
// ks_root's order (lib/ks-root.sh): KS_ROOT_<NAME> > registry > sibling >
// `claude plugin list --json` (readFromFolder before installPath).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SCRIPTS_DIR } from './env.js'

function fixture(listJson = '[]') {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-root-'))
  const mk = (name: string) => {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true })
    return d
  }
  const claude = join(dir, 'claude')
  writeFileSync(claude, `#!/bin/bash\ncat <<'JSON'\n${listJson}\nJSON\n`)
  chmodSync(claude, 0o755)
  return { dir, mk, claude, config: mk('config') }
}

function ksRoot(name: string, env: Record<string, string>): { out: string; code: number } {
  const r = spawnSync('bash', ['-c', `. "${SCRIPTS_DIR}/lib/ks-root.sh"; ks_root "$1"`, 'x', name], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: env.HOME ?? '/nonexistent', ...env },
  })
  return { out: r.stdout, code: r.status ?? -1 }
}

test('KS_ROOT_<NAME> wins', () => {
  const f = fixture()
  const d = f.mk('from-env')
  assert.equal(ksRoot('ks-zz', { KS_ROOT_KS_ZZ: d, KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude }).out, d)
})

test('then the registry', () => {
  const f = fixture()
  const d = f.mk('from-registry')
  writeFileSync(join(f.config, 'plugins.json'), JSON.stringify({ 'ks-zz': { root: d } }))
  assert.equal(ksRoot('ks-zz', { KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude }).out, d)
})

test('a registry entry whose folder is gone is skipped', () => {
  const f = fixture()
  writeFileSync(join(f.config, 'plugins.json'), JSON.stringify({ 'ks-zz': { root: join(f.dir, 'gone') } }))
  assert.equal(ksRoot('ks-zz', { KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude }).code, 1)
})

test('a sibling plugin folder is found in a clone', () => {
  const f = fixture()
  const r = ksRoot('ks-flow', { KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude })
  assert.equal(r.out, join(SCRIPTS_DIR, '..', '..', 'ks-flow').replace(/\/plugins\/ks\/scripts\/\.\.\/\.\./, '/plugins'))
})

test('claude plugin list: readFromFolder beats installPath, newest entry wins', () => {
  const src = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-root-src-'))
  const cache = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-root-cache-'))
  const list = JSON.stringify([
    { id: 'ks-zz@old', installPath: cache, lastUpdated: '2026-01-01' },
    { id: 'ks-zz@karmasuite', installPath: cache, readFromFolder: src, lastUpdated: '2026-02-01' },
    { id: 'other@karmasuite', installPath: cache, lastUpdated: '2026-03-01' },
  ])
  const f = fixture(list)
  assert.equal(ksRoot('ks-zz', { KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude }).out, src)
})

test('unknown everywhere → exit 1', () => {
  const f = fixture()
  assert.equal(ksRoot('ks-zz', { KS_CONFIG_DIR: f.config, KS_CLAUDE_BIN: f.claude }).code, 1)
})
