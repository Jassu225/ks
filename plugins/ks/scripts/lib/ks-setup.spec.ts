// Run: node --import tsx --test lib/ks-setup.spec.ts
// `ks-setup doctor --json` is what /ks:setup reads: pin its shape, and that it
// reports missing config without touching anything (throwaway HOME).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SCRIPTS_DIR } from './env.js'

test('doctor --json: mode, error count and well-formed checks', () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-setup-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      KS_SECURITY_BIN: '/usr/bin/false',
      KSC_LEGACY_FILES: '',
      KS_CLAUDE_BIN: '/usr/bin/false',
    },
    timeout: 60_000,
  })
  const out = JSON.parse(r.stdout) as {
    mode: string
    errors: number
    checks: { id: string; level: string; ok: boolean; message: string; fix: string | null }[]
  }
  assert.equal(out.mode, 'launcher')
  assert.ok(out.errors >= 2, 'project path and Linear key are missing')
  assert.equal(r.status, 1)
  for (const c of out.checks) {
    assert.match(c.level, /^(error|warn|info)$/)
    assert.equal(typeof c.ok, 'boolean')
    assert.ok(c.message)
  }
  const linear = out.checks.find((c) => c.id === 'config:LINEAR_API_KEY')
  assert.equal(linear?.ok, false)
  assert.match(linear?.fix ?? '', /ks-config secret linear\.LINEAR_API_KEY/)
  assert.equal(out.checks.find((c) => c.id === 'sandbox')?.ok, false)
})

test('doctor: a Keychain entry with an EMPTY value counts as unset', () => {
  // `security find-generic-password -w` exits 0 and prints only a newline for
  // an item stored with an empty password; the CLIs treat that as no token.
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-setup-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  const sec = join(home, 'security')
  writeFileSync(sec, '#!/bin/sh\necho ""\nexit 0\n', { mode: 0o755 })
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      KS_SECURITY_BIN: sec,
      KSC_LEGACY_FILES: '',
      KS_CLAUDE_BIN: '/usr/bin/false',
    },
    timeout: 60_000,
  })
  const out = JSON.parse(r.stdout) as { checks: { id: string; ok: boolean; fix: string | null }[] }
  const linear = out.checks.find((c) => c.id === 'config:LINEAR_API_KEY')
  assert.equal(linear?.ok, false)
  assert.match(linear?.fix ?? '', /ks-config secret linear\.LINEAR_API_KEY/)
})

test('claude-settings --yes adds the Keychain deny rules; doctor then passes secrets:deny', () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-setup-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const settings = join(home, '.claude', 'settings.json')
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Read(.env)'] } }))
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    KS_SECURITY_BIN: '/usr/bin/false',
    KSC_LEGACY_FILES: '',
    KS_CLAUDE_BIN: '/usr/bin/false',
  }
  const before = JSON.parse(
    spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], { encoding: 'utf8', env, timeout: 60_000 }).stdout,
  ) as { checks: { id: string; ok: boolean }[] }
  assert.equal(before.checks.find((c) => c.id === 'secrets:deny')?.ok, false)

  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['claude-settings', '--yes'], { encoding: 'utf8', env, timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  const s = JSON.parse(readFileSync(settings, 'utf8')) as { permissions: { deny: string[] } }
  assert.deepEqual(s.permissions.deny, ['Read(.env)', 'Bash(security *)', 'Bash(/usr/bin/security *)'])

  const after = JSON.parse(
    spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], { encoding: 'utf8', env, timeout: 60_000 }).stdout,
  ) as { checks: { id: string; ok: boolean }[] }
  assert.equal(after.checks.find((c) => c.id === 'secrets:deny')?.ok, true)
})
