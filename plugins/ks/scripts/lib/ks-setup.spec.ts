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

// ks-flow:device — this device on the shared board. A fake `ks-flow` on PATH
// answers `device-id --json`; a fake daemon store-check (in the data dir, where
// bootstrap builds the real one) answers whether meta/settings exists.
function deviceDoctor(store: 'firestore' | 'pocketbase', check: object | null, version: object | null = null) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-setup-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'ks-flow'),
    '#!/bin/sh\n[ "$1 $2" = "device-id --json" ] && echo \'{"deviceId":"0123456789abcdef","defaultName":"Test Mac"}\' && exit 0\nexit 2\n',
    { mode: 0o755 },
  )
  const proj = join(home, 'karmasuite')
  mkdirSync(proj)
  const data = join(home, 'ks-flow-data')
  mkdirSync(join(data, 'daemon', 'dist'), { recursive: true })
  writeFileSync(join(data, 'project.conf'), '{}')
  writeFileSync(
    join(data, '.env'),
    store === 'firestore'
      ? 'DB_PROVIDER=firestore\nFIRESTORE_MODE=cloud\nFIREBASE_PROJECT_ID=test-project\n'
      : 'DB_PROVIDER=pocketbase\n',
  )
  if (version) writeFileSync(join(data, 'version-status.json'), JSON.stringify(version))
  if (check) {
    // Answers only when the doctor hands it this data dir.
    writeFileSync(
      join(data, 'daemon', 'dist', 'store-check.js'),
      `if (process.env.KS_FLOW_DATA === ${JSON.stringify(data)}) console.log(${JSON.stringify(JSON.stringify(check))})\n`,
    )
  }
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      KS_SECURITY_BIN: '/usr/bin/false',
      KSC_LEGACY_FILES: '',
      KS_CLAUDE_BIN: '/usr/bin/false',
      KS_PROJECT_ROOT_PATH: proj,
      KS_FLOW_DATA: data,
    },
    timeout: 60_000,
  })
  const out = JSON.parse(r.stdout) as {
    checks: { id: string; level: string; ok: boolean; message: string; fix: string | null }[]
  }
  return {
    data,
    device: out.checks.find((c) => c.id === 'ks-flow:device'),
    version: out.checks.find((c) => c.id === 'ks-flow:version'),
  }
}

test('ks-flow:device: Firestore not set up for devices → the backfill command, with this data dir', () => {
  const { data, device } = deviceDoctor('firestore', { ok: true, devicesSetUp: false })
  assert.equal(device?.level, 'info')
  assert.equal(device?.ok, false)
  assert.match(device?.message ?? '', /this device: Test Mac \(0123456789abcdef\)/)
  assert.match(device?.message ?? '', /meta\/settings/)
  assert.match(device?.fix ?? '', /^run the device backfill: /)
  assert.match(device?.fix ?? '', /backfill-devices\.ts --data-dir/)
  assert.ok(device?.fix?.includes(data), 'the fix names this data dir')
  assert.match(device?.fix ?? '', /--dry-run/)
})

test('ks-flow:device: set up → ok, names the master device', () => {
  const { device } = deviceDoctor('firestore', { ok: true, devicesSetUp: true, masterDeviceId: '0123456789abcdef' })
  assert.equal(device?.ok, true)
  assert.match(device?.message ?? '', /master device 0123456789abcdef \(this one\)/)
})

test('ks-flow:device: the store does not answer → unknown, not the backfill', () => {
  const { device } = deviceDoctor('firestore', { ok: false, error: 'no answer in 8s' })
  assert.equal(device?.ok, false)
  assert.match(device?.message ?? '', /unknown/)
  assert.doesNotMatch(device?.fix ?? '', /backfill/)
})

test('ks-flow:device: PocketBase → just the id and name', () => {
  const { device } = deviceDoctor('pocketbase', null)
  assert.equal(device?.ok, true)
  assert.equal(device?.message, 'this device: Test Mac (0123456789abcdef)')
})

// ks-flow:version — this device's ks-flow against the store's, from the
// daemon's version-status.json in the data dir.
const VERSION_BASE = {
  version: '1.4.2',
  schemaVersion: 1,
  dev: false,
  devReason: null,
  storeVersion: '1.4.2',
  storeSchemaVersion: 1,
  versionBehind: false,
  schemaBehind: false,
  readOnly: false,
  update: null,
}

test('ks-flow:version: no status file yet → unknown, start the daemon', () => {
  const { version } = deviceDoctor('pocketbase', null)
  assert.equal(version?.ok, false)
  assert.equal(version?.level, 'info')
  assert.match(version?.message ?? '', /unknown/)
  assert.equal(version?.fix, 'ks-flow start')
})

test('ks-flow:version: up to date → ok with the version; a dev build says so', () => {
  const { version } = deviceDoctor('pocketbase', null, VERSION_BASE)
  assert.equal(version?.ok, true)
  assert.equal(version?.message, 'ks-flow 1.4.2 (data format 1), up to date with the store')
  const dev = deviceDoctor('pocketbase', null, { ...VERSION_BASE, dev: true, devReason: 'uncommitted changes' }).version
  assert.equal(dev?.ok, true)
  assert.match(dev?.message ?? '', /; dev build: uncommitted changes$/)
})

test('ks-flow:version: behind on the release → a warning naming both versions', () => {
  const { version } = deviceDoctor('pocketbase', null, { ...VERSION_BASE, storeVersion: '1.5.0', versionBehind: true })
  assert.equal(version?.level, 'warn')
  assert.equal(version?.ok, false)
  assert.equal(version?.message, "ks-flow 1.4.2 on this device is behind the store's 1.5.0; it updates itself")
  assert.equal(version?.fix, 'ks-flow update')
})

test('ks-flow:version: behind on the data format → an error: read-only, with the failed update', () => {
  const { version } = deviceDoctor('pocketbase', null, {
    ...VERSION_BASE,
    storeVersion: '2.0.0',
    storeSchemaVersion: 2,
    versionBehind: true,
    schemaBehind: true,
    readOnly: true,
    update: { state: 'refused', startedAt: '2026-11-16T00:00:00Z', reason: 'the clone has uncommitted changes' },
  })
  assert.equal(version?.level, 'error')
  assert.equal(version?.ok, false)
  assert.match(version?.message ?? '', /behind the store's data format \(schema 1 < 2\): its board is read-only/)
  assert.match(version?.message ?? '', /the last update failed: the clone has uncommitted changes$/)
})
