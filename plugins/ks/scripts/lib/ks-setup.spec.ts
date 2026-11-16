// Run: node --import tsx --test lib/ks-setup.spec.ts
// `ks-setup doctor --json` is what /ks:setup reads: pin its shape, and that it
// reports missing config without touching anything (throwaway HOME).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
  // The sandbox is off in these settings: nothing needs excluding.
  const sandbox = out.checks.find((c) => c.id === 'sandbox')
  assert.equal(sandbox?.ok, true)
  assert.equal(sandbox?.level, 'info')
  assert.equal(out.checks.find((c) => c.id === 'sandbox:ks-setup'), undefined)
})

test('doctor --json: sandbox on → ks-setup first, then the KS commands', () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-setup-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }))
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['doctor', '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, KS_SECURITY_BIN: '/usr/bin/false', KSC_LEGACY_FILES: '', KS_CLAUDE_BIN: '/usr/bin/false' },
    timeout: 60_000,
  })
  const out = JSON.parse(r.stdout) as { checks: { id: string; level: string; ok: boolean; fix: string | null }[] }
  const self = out.checks.find((c) => c.id === 'sandbox:ks-setup')
  assert.equal(self?.ok, false)
  assert.equal(self?.level, 'error')
  assert.equal(self?.fix, '! ks-setup claude-settings --self')
  const sandbox = out.checks.find((c) => c.id === 'sandbox')
  assert.equal(sandbox?.ok, false)
  assert.equal(sandbox?.level, 'warn')
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
    release: out.checks.find((c) => c.id === 'ks-flow:release'),
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

// ks-flow:release — the daemon's hourly `ks-setup update --check` (version-status.json .release).
test('ks-flow:release: absent → no line; available → a warning naming the versions; current → ok', () => {
  assert.equal(deviceDoctor('pocketbase', null, VERSION_BASE).release, undefined)
  const plugins = [
    { plugin: 'ks', installed: '1.0.6', latest: '1.0.7' },
    { plugin: 'ks-flow', installed: '0.3.0', latest: '0.3.0' },
  ]
  const avail = deviceDoctor('pocketbase', null, {
    ...VERSION_BASE,
    release: { checkedAt: '2026-11-16T10:00:00Z', state: 'available', plugins, reason: null },
  }).release
  assert.equal(avail?.level, 'warn')
  assert.equal(avail?.ok, false)
  assert.equal(avail?.message, 'a new KS release: ks 1.0.6 → 1.0.7 (checked 2026-11-16 10:00)')
  assert.match(avail?.fix ?? '', /^ks-setup update/)
  const cur = deviceDoctor('pocketbase', null, {
    ...VERSION_BASE,
    release: { checkedAt: '2026-11-16T10:00:00Z', state: 'current', plugins: [], reason: null },
  }).release
  assert.equal(cur?.ok, true)
})

// ── ks-setup update ─────────────────────────────────────────────────────────
// A throwaway HOME with Claude's plugin files, the karmasuite marketplace and
// its cache, and a stub `claude` that logs "<cwd>|<argv>" and acts like the
// real one on these files: `plugin marketplace update` applies $HOME/bump.json
// to the marketplace's plugin.json versions; `plugin update <p>@karmasuite
// --scope <s>` copies the entry's folder to cache/<p>/<new version> and points
// the entry (scope + cwd) at it. The cached ks has a stub scripts/ks-setup and
// ks-flow a stub bin/ks-flow, each logging where it ran from.

interface UpdateOut {
  state: string
  mode: string | null
  plugins: { plugin: string; from: string | null; to: string | null; projects: { path: string | null; scope: string; from: string | null; to: string | null; ok: boolean }[] }[]
  reason: string | null
  log: string
  by: string
  restarted: boolean
}

const CLAUDE_STUB = String.raw`#!/bin/bash
H="__HOME__"
printf '%s|%s\n' "$PWD" "$*" >> "$H/claude-calls"
pd="$H/.claude/plugins"; mk="$pd/marketplaces/karmasuite"
case "$1 $2" in
  "plugin marketplace")
    [ -f "$H/bump.json" ] || exit 0
    for p in $(jq -r 'keys[]' "$H/bump.json"); do
      f="$mk/plugins/$p/.claude-plugin/plugin.json"
      jq --arg v "$(jq -r --arg p "$p" '.[$p]' "$H/bump.json")" '.version = $v' "$f" >"$f.t" && mv "$f.t" "$f"
    done ;;
  "plugin update")
    id="$3"; p="$(printf %s "$id" | cut -d@ -f1)"; s="$5"; pp="$PWD"; [ "$s" = user ] && pp=""
    [ -f "$H/fail-$p" ] && { echo "boom: $p"; exit 1; }
    v="$(jq -r .version "$mk/plugins/$p/.claude-plugin/plugin.json")"
    old="$(jq -r --arg id "$id" --arg s "$s" --arg pp "$pp" '.plugins[$id][] | select(.scope == $s and (.projectPath // "") == $pp) | .installPath' "$pd/installed_plugins.json" | head -1)"
    new="$pd/cache/karmasuite/$p/$v"
    if [ ! -d "$new" ]; then
      cp -R "$old" "$new"
      jq --arg v "$v" '.version = $v' "$new/.claude-plugin/plugin.json" >"$new/t" && mv "$new/t" "$new/.claude-plugin/plugin.json"
    fi
    f="$pd/installed_plugins.json"
    jq --arg id "$id" --arg s "$s" --arg pp "$pp" --arg v "$v" --arg ip "$new" \
      '.plugins[$id] |= map(if .scope == $s and (.projectPath // "") == $pp then .version = $v | .installPath = $ip else . end)' "$f" >"$f.t" && mv "$f.t" "$f"
    echo '{"ok":true}' ;;
  "plugin list") echo '[]' ;;
esac
exit 0
`

function exe(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode: 0o755 })
}
function pluginDir(dir: string, name: string, version: string) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
  return dir
}
/** Stubs for the copy's own ks-setup (shims) and ks-flow (restart): they log their folder. */
function stubCommands(home: string, ks: string | null, flow: string | null) {
  if (ks) exe(join(ks, 'scripts', 'ks-setup'), `#!/bin/bash\nprintf '%s|%s\\n' "$(cd "$(dirname "$0")/.." && pwd)" "$*" >> "${home}/shims-calls"\n`)
  if (flow) {
    exe(
      join(flow, 'bin', 'ks-flow'),
      `#!/bin/bash\nprintf '%s|%s|%s|NB=%s\\n' "$(cd "$(dirname "$0")/.." && pwd)" "$PWD" "$*" "$KS_FLOW_NO_BROWSER" >> "${home}/flow-calls"\n`,
    )
  }
}

function marketplaceFixture() {
  const home = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-update-')))
  const pd = join(home, '.claude', 'plugins')
  const mk = join(pd, 'marketplaces', 'karmasuite')
  const cache = join(pd, 'cache', 'karmasuite')
  const proj = join(home, 'karmasuite')
  const wt1 = join(home, 'worktrees', 'kar-1')
  const wt2 = join(home, 'worktrees', 'kar-2-removed') // never created: the worktree is gone
  mkdirSync(proj, { recursive: true })
  mkdirSync(wt1, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  const versions: Record<string, string> = { 'ks-suite': '1.0.0', ks: '1.0.6', 'ks-flow': '0.2.2' }
  for (const [p, v] of Object.entries(versions)) {
    pluginDir(join(mk, 'plugins', p), p, v)
    pluginDir(join(cache, p, v), p, v)
  }
  stubCommands(home, join(cache, 'ks', '1.0.6'), join(cache, 'ks-flow', '0.2.2'))
  mkdirSync(join(mk, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(mk, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'karmasuite', plugins: Object.entries(versions).map(([name, version]) => ({ name, source: `./plugins/${name}`, version })) }),
  )
  writeFileSync(
    join(pd, 'known_marketplaces.json'),
    JSON.stringify({ karmasuite: { source: { source: 'github', repo: 'example/ks' }, installLocation: mk } }),
  )
  const entry = (p: string, projectPath: string) => ({
    scope: 'local',
    projectPath,
    installPath: join(cache, p, versions[p]),
    version: versions[p],
  })
  writeFileSync(
    join(pd, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'ks-suite@karmasuite': [entry('ks-suite', proj)],
        'ks@karmasuite': [entry('ks', proj), entry('ks', wt1), entry('ks', wt2)],
        'ks-flow@karmasuite': [entry('ks-flow', proj), entry('ks-flow', wt1)],
      },
    }),
  )
  const bin = join(home, 'stub-bin')
  exe(join(bin, 'claude'), CLAUDE_STUB.replace('__HOME__', home))
  return { home, proj, wt1, wt2, cache, pd, bin }
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
}

function runUpdate(home: string, bin: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['update', ...args], {
    encoding: 'utf8',
    cwd: home,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      KS_SECURITY_BIN: '/usr/bin/false',
      KSC_LEGACY_FILES: '',
      KS_CLAUDE_BIN: join(bin, 'claude'),
      KS_PROJECT_ROOT_PATH: join(home, 'karmasuite'),
      ...env,
    },
    timeout: 60_000,
  })
  let out: UpdateOut | null = null
  try {
    out = JSON.parse(r.stdout) as UpdateOut
  } catch {
    /* not --json, or it failed */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out }
}

test('update (installed): marketplace refresh, then one claude call per out-of-date install, in its folder', () => {
  const f = marketplaceFixture()
  writeFileSync(join(f.home, 'bump.json'), JSON.stringify({ ks: '1.0.7', 'ks-flow': '0.3.0' }))
  const r = runUpdate(f.home, f.bin, ['--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [
    `${f.proj}|plugin marketplace update karmasuite`,
    `${f.proj}|plugin update ks@karmasuite --scope local --json`,
    `${f.wt1}|plugin update ks@karmasuite --scope local --json`,
    `${f.proj}|plugin update ks-flow@karmasuite --scope local --json`,
    `${f.wt1}|plugin update ks-flow@karmasuite --scope local --json`,
  ])
  const out = r.out!
  assert.equal(out.state, 'updated')
  assert.equal(out.mode, 'marketplace')
  assert.equal(out.reason, null)
  assert.equal(out.by, 'manual')
  assert.equal(out.log, join(f.home, '.config', 'ks', 'update.log'))
  const ks = out.plugins.find((p) => p.plugin === 'ks')
  assert.deepEqual(
    { from: ks?.from, to: ks?.to },
    { from: '1.0.6', to: '1.0.7' },
  )
  assert.deepEqual(ks?.projects, [
    { path: f.proj, scope: 'local', from: '1.0.6', to: '1.0.7', ok: true },
    { path: f.wt1, scope: 'local', from: '1.0.6', to: '1.0.7', ok: true },
  ])
  const suite = out.plugins.find((p) => p.plugin === 'ks-suite')
  assert.deepEqual(suite?.projects, [{ path: f.proj, scope: 'local', from: '1.0.0', to: '1.0.0', ok: true }])
  assert.ok(!r.stdout.includes('plugin marketplace'), 'stdout holds only the JSON')
  // The NEW copies ran: ks 1.0.7's ks-setup shims, ks-flow 0.3.0's update --no-fetch (no browser).
  assert.deepEqual(lines(join(f.home, 'shims-calls')), [`${join(f.cache, 'ks', '1.0.7')}|shims`])
  assert.deepEqual(lines(join(f.home, 'flow-calls')), [`${join(f.cache, 'ks-flow', '0.3.0')}|${f.proj}|update --no-fetch|NB=1`])
  assert.equal(out.restarted, true)
  assert.ok(!existsSync(join(f.home, '.config', 'ks', 'update.lock')), 'the lock is released')
  assert.match(readFileSync(out.log, 'utf8'), /\[ks-setup update\] done: updated: ks 1\.0\.6 → 1\.0\.7, ks-flow 0\.2\.2 → 0\.3\.0/)
})

test('update --check: only the marketplace refresh; reports what is available, installs nothing', () => {
  const f = marketplaceFixture()
  writeFileSync(join(f.home, 'bump.json'), JSON.stringify({ ks: '1.0.7' }))
  const before = readFileSync(join(f.pd, 'installed_plugins.json'), 'utf8')
  const r = runUpdate(f.home, f.bin, ['--check', '--json', '--auto'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [`${f.proj}|plugin marketplace update karmasuite`])
  assert.equal(readFileSync(join(f.pd, 'installed_plugins.json'), 'utf8'), before)
  assert.equal(r.out?.state, 'available')
  assert.equal(r.out?.by, 'auto')
  const ks = r.out?.plugins.find((p) => p.plugin === 'ks')
  assert.equal(ks?.to, '1.0.7')
  assert.deepEqual(ks?.projects.map((p) => p.ok), [false, false])
  assert.deepEqual(lines(join(f.home, 'flow-calls')), [])
})

test('update: nothing newer → current, no update calls, no restart', () => {
  const f = marketplaceFixture()
  const r = runUpdate(f.home, f.bin, ['--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.out?.state, 'current')
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [`${f.proj}|plugin marketplace update karmasuite`])
  assert.deepEqual(lines(join(f.home, 'flow-calls')), [])
  assert.deepEqual(lines(join(f.home, 'shims-calls')), [])
})

test('update --no-restart: updates, refreshes the shims, leaves ks-flow running', () => {
  const f = marketplaceFixture()
  writeFileSync(join(f.home, 'bump.json'), JSON.stringify({ 'ks-flow': '0.3.0' }))
  const r = runUpdate(f.home, f.bin, ['--no-restart', '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.out?.state, 'updated')
  assert.equal(r.out?.restarted, false)
  assert.deepEqual(lines(join(f.home, 'flow-calls')), [])
  assert.equal(lines(join(f.home, 'shims-calls')).length, 1)
})

test('update: a failed install → failed (exit 1), the others still updated', () => {
  const f = marketplaceFixture()
  writeFileSync(join(f.home, 'bump.json'), JSON.stringify({ ks: '1.0.7', 'ks-flow': '0.3.0' }))
  writeFileSync(join(f.home, 'fail-ks-flow'), '')
  const r = runUpdate(f.home, f.bin, ['--no-restart', '--json'])
  assert.equal(r.status, 1)
  assert.equal(r.out?.state, 'failed')
  assert.match(r.out?.reason ?? '', /ks-flow in .*: claude plugin update failed \(exit 1\): boom: ks-flow/)
  assert.deepEqual(r.out?.plugins.find((p) => p.plugin === 'ks')?.projects.map((p) => p.ok), [true, true])
  assert.deepEqual(r.out?.plugins.find((p) => p.plugin === 'ks-flow')?.projects.map((p) => p.ok), [false, false])
})

test('update: another run holds the lock → busy, exit 3, nothing runs; a stale lock is taken', () => {
  const f = marketplaceFixture()
  const lock = join(f.home, '.config', 'ks', 'update.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`) // alive: this test runner
  writeFileSync(join(lock, 'startedAt'), '2026-11-16T10:00:00Z\n')
  const held = runUpdate(f.home, f.bin, ['--json'])
  assert.equal(held.status, 3)
  assert.equal(held.out?.state, 'busy')
  assert.match(held.out?.reason ?? '', /another update is running/)
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [])
  assert.ok(existsSync(join(lock, 'pid')), "another run's lock is left alone")

  writeFileSync(join(lock, 'pid'), '999999\n') // gone
  const stale = runUpdate(f.home, f.bin, ['--json'])
  assert.equal(stale.status, 0, stale.stderr)
  assert.equal(stale.out?.state, 'current')
  assert.ok(!existsSync(lock))
  assert.match(readFileSync(join(f.home, '.config', 'ks', 'update.log'), 'utf8'), /stale update lock \(pid 999999/)
})

test('update: unknown option → usage, exit 2', () => {
  const f = marketplaceFixture()
  const r = runUpdate(f.home, f.bin, ['--bogus'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown option --bogus/)
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [])
})

// A clone: an "origin" bare repo, the clone the plugins run from (KS_ROOT_*), and
// a second clone that pushes a release.
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function cloneFixture() {
  const home = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-update-clone-')))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  mkdirSync(join(home, 'karmasuite'))
  const origin = join(home, 'origin.git')
  git(home, 'init', '--bare', '-b', 'main', origin)
  const seed = join(home, 'seed')
  git(home, 'clone', origin, seed)
  git(seed, 'checkout', '-b', 'main')
  pluginDir(join(seed, 'plugins', 'ks'), 'ks', '1.0.6')
  pluginDir(join(seed, 'plugins', 'ks-flow'), 'ks-flow', '0.2.2')
  stubCommands(home, join(seed, 'plugins', 'ks'), join(seed, 'plugins', 'ks-flow'))
  // the stubs log the folder they run from, so give each clone its own
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'init')
  git(seed, 'push', '-u', 'origin', 'main')
  const repo = join(home, 'ks')
  git(home, 'clone', origin, repo)
  const bin = join(home, 'stub-bin')
  exe(join(bin, 'claude'), CLAUDE_STUB.replace('__HOME__', home))
  const env = {
    KS_ROOT_KS: join(repo, 'plugins', 'ks'),
    KS_ROOT_KS_FLOW: join(repo, 'plugins', 'ks-flow'),
    KS_ROOT_KS_MASTER: join(home, 'none'),
    KS_ROOT_KS_BROWSER: join(home, 'none'),
    ...GIT_ENV,
  }
  const release = (files: Record<string, string>) => {
    for (const [p, v] of Object.entries(files)) pluginDir(join(seed, 'plugins', p), p, v)
    git(seed, 'commit', '-am', 'release')
    git(seed, 'push')
  }
  return { home, repo, bin, env, release }
}

test('update (clone): refused off main and with uncommitted changes', () => {
  const c = cloneFixture()
  git(c.repo, 'checkout', '-b', 'feature')
  const off = runUpdate(c.home, c.bin, ['--json'], c.env)
  assert.equal(off.status, 1)
  assert.equal(off.out?.state, 'refused')
  assert.equal(off.out?.mode, 'clone')
  assert.match(off.out?.reason ?? '', /on branch feature, not main/)
  git(c.repo, 'checkout', 'main')
  writeFileSync(join(c.repo, 'plugins', 'ks', '.claude-plugin', 'plugin.json'), '{"name":"ks","version":"9"}')
  const dirty = runUpdate(c.home, c.bin, ['--json'], c.env)
  assert.equal(dirty.status, 1)
  assert.match(dirty.out?.reason ?? '', /uncommitted changes/)
  assert.deepEqual(lines(join(c.home, 'claude-calls')), [], 'a clone never calls claude plugin')
})

test('update (clone): --check fetches and compares; update pulls, refreshes shims, restarts ks-flow', () => {
  const c = cloneFixture()
  const head = git(c.repo, 'rev-parse', 'HEAD')
  const none = runUpdate(c.home, c.bin, ['--check', '--json'], c.env)
  assert.equal(none.out?.state, 'current', none.stderr)

  c.release({ ks: '1.0.7', 'ks-flow': '0.3.0' })
  const chk = runUpdate(c.home, c.bin, ['--check', '--json'], c.env)
  assert.equal(chk.status, 0, chk.stderr)
  assert.equal(chk.out?.state, 'available')
  assert.deepEqual(
    chk.out?.plugins.map((p) => [p.plugin, p.from, p.to]),
    [
      ['ks', '1.0.6', '1.0.7'],
      ['ks-flow', '0.2.2', '0.3.0'],
    ],
  )
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), head, '--check does not pull')

  const r = runUpdate(c.home, c.bin, ['--json'], c.env)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.out?.state, 'updated')
  assert.notEqual(git(c.repo, 'rev-parse', 'HEAD'), head)
  assert.deepEqual(lines(join(c.home, 'shims-calls')), [`${join(c.repo, 'plugins', 'ks')}|shims`])
  assert.deepEqual(lines(join(c.home, 'flow-calls')), [`${join(c.repo, 'plugins', 'ks-flow')}|${join(c.home, 'karmasuite')}|update --no-fetch|NB=1`])
  assert.deepEqual(lines(join(c.home, 'claude-calls')), [])
})

test('shims: rewrites the v2 shims from this copy, prunes gone and marketplace registry entries', () => {
  const f = marketplaceFixture()
  const cfg = join(f.home, '.config', 'ks')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(
    join(cfg, 'plugins.json'),
    JSON.stringify({
      ks: { root: join(f.cache, 'ks', '1.0.6'), mode: 'marketplace' },
      'ks-master': { root: join(f.home, 'gone'), mode: 'local' },
    }),
  )
  const r = spawnSync(join(SCRIPTS_DIR, 'ks-setup'), ['shims'], {
    encoding: 'utf8',
    cwd: f.home,
    env: { PATH: `${f.bin}:${process.env.PATH ?? ''}`, HOME: f.home, KS_SECURITY_BIN: '/usr/bin/false', KSC_LEGACY_FILES: '', KS_CLAUDE_BIN: join(f.bin, 'claude') },
    timeout: 60_000,
  })
  assert.equal(r.status, 0, r.stderr)
  // (ks-master and ks-browser may be recorded again: here they resolve to this clone's siblings)
  const reg = JSON.parse(readFileSync(join(cfg, 'plugins.json'), 'utf8')) as Record<string, { root: string; mode: string }>
  assert.equal(reg.ks, undefined, 'the marketplace-mode entry is dropped')
  assert.notEqual(reg['ks-master']?.root, join(f.home, 'gone'), 'the gone root is dropped')
  const shim = readFileSync(join(f.home, '.local', 'bin', 'ks-flow'), 'utf8')
  assert.match(shim, /^# ks-shim v2$/m)
  assert.deepEqual(lines(join(f.home, 'claude-calls')), [], 'never spawns claude')
})
