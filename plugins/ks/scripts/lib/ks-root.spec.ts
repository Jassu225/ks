// Run: node --import tsx --test lib/ks-root.spec.ts
// lib/ks-root.sh: ksr_live_root's order KS_ROOT_<NAME> > directory marketplace >
// installed_plugins.json entry (cwd's, the KS checkout's, user/managed, rest by
// version; gone folders skipped) > registry `mode: local` > sibling; ks_root adds
// `claude plugin list --json`. Plus ks_register_root and the v2 shims. Every case
// runs with a throwaway HOME.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { SCRIPTS_DIR } from './env.js'

const LIB = join(SCRIPTS_DIR, 'lib', 'ks-root.sh')
const CLONE_PLUGINS = join(SCRIPTS_DIR, '..', '..').replace(/\/plugins\/ks\/scripts\/\.\.\/\.\.$/, '/plugins')
// jq's folder only, so `claude` is not on PATH unless a test puts a stub there.
const JQ_DIR = dirname(spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim())
const BASE_PATH = [...new Set([JQ_DIR, '/usr/bin', '/bin'])].join(':')

interface Entry {
  scope: string
  projectPath?: string
  installPath: string
  version?: string
}

function fixture() {
  // realpath: bash reports a physical cwd (macOS /tmp is a symlink)
  const home = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ks-root-')))
  const mk = (...parts: string[]) => {
    const d = join(home, ...parts)
    mkdirSync(d, { recursive: true })
    return d
  }
  const plugins = mk('.claude', 'plugins')
  const config = mk('.config', 'ks')
  return {
    home,
    mk,
    config,
    /** A plugin folder declaring <name>, with bin/<cmd> printing its own folder. */
    plugin(dir: string, name: string, cmd = 'whereami') {
      mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
      writeFileSync(join(dir, 'bin', cmd), `#!/bin/sh\nprintf '%s' "${dir}"\n`)
      chmodSync(join(dir, 'bin', cmd), 0o755)
      return dir
    },
    installed(name: string, entries: Entry[]) {
      writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`${name}@karmasuite`]: entries } }))
    },
    directoryMarketplace(dir: string) {
      writeFileSync(
        join(plugins, 'known_marketplaces.json'),
        JSON.stringify({ karmasuite: { source: { source: 'directory', path: dir }, installLocation: dir } }),
      )
    },
    registry(reg: Record<string, unknown>) {
      writeFileSync(join(config, 'plugins.json'), JSON.stringify(reg))
    },
    /** A `claude` stub that logs each call and prints <listJson>. */
    claude(listJson = '[]') {
      const bin = mk('stub-bin')
      writeFileSync(join(bin, 'claude'), `#!/bin/bash\necho called >> "${home}/claude-calls"\ncat <<'JSON'\n${listJson}\nJSON\n`)
      chmodSync(join(bin, 'claude'), 0o755)
      return bin
    },
    claudeCalled: () => existsSync(join(home, 'claude-calls')),
  }
}

function sh(script: string, args: string[], home: string, opts: { cwd?: string; env?: Record<string, string>; path?: string } = {}) {
  const r = spawnSync('bash', ['-c', script, 'x', ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? home,
    env: { PATH: opts.path ?? BASE_PATH, HOME: home, ...opts.env },
  })
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 }
}

const ksRoot = (name: string, home: string, opts?: Parameters<typeof sh>[3]) =>
  sh(`. "${LIB}"; ks_root "$1"`, [name], home, opts)

test('KS_ROOT_<NAME> wins over everything', () => {
  const f = fixture()
  const mp = f.mk('clone')
  f.plugin(join(mp, 'plugins', 'ks-zz'), 'ks-zz')
  f.directoryMarketplace(mp)
  const d = f.mk('from-env')
  assert.equal(ksRoot('ks-zz', f.home, { env: { KS_ROOT_KS_ZZ: d } }).out, d)
})

test('a directory marketplace beats a stale cache entry', () => {
  const f = fixture()
  const mp = f.mk('clone')
  const live = f.plugin(join(mp, 'plugins', 'ks-zz'), 'ks-zz')
  const stale = f.plugin(f.mk('.claude', 'plugins', 'cache', 'karmasuite', 'ks-zz', '1.0.0'), 'ks-zz')
  f.directoryMarketplace(mp)
  f.installed('ks-zz', [{ scope: 'local', projectPath: f.home, installPath: stale, version: '1.0.0' }])
  assert.equal(ksRoot('ks-zz', f.home).out, live)
})

test('a directory-marketplace folder declaring another name is skipped', () => {
  const f = fixture()
  const mp = f.mk('clone')
  f.plugin(join(mp, 'plugins', 'ks-zz'), 'something-else')
  const inst = f.plugin(f.mk('inst'), 'ks-zz')
  f.directoryMarketplace(mp)
  f.installed('ks-zz', [{ scope: 'user', installPath: inst }])
  assert.equal(ksRoot('ks-zz', f.home).out, inst)
})

test("the cwd's entry beats the KS checkout's; elsewhere the checkout's wins", () => {
  const f = fixture()
  const checkout = f.mk('karmasuite')
  const wt = f.mk('worktrees', 'kar-1')
  const a = f.plugin(f.mk('cache', 'ks-zz', '1.0.6'), 'ks-zz')
  const b = f.plugin(f.mk('cache', 'ks-zz', '1.0.7'), 'ks-zz')
  f.installed('ks-zz', [
    { scope: 'local', projectPath: checkout, installPath: a, version: '1.0.6' },
    { scope: 'local', projectPath: wt, installPath: b, version: '1.0.7' },
  ])
  const env = { KS_PROJECT_ROOT_PATH: checkout }
  assert.equal(ksRoot('ks-zz', f.home, { cwd: f.mk('worktrees', 'kar-1', 'src'), env }).out, b)
  assert.equal(ksRoot('ks-zz', f.home, { cwd: f.home, env }).out, a)
  // the checkout from ks.env when the env has none (quoted, export prefix)
  writeFileSync(join(f.config, 'ks.env'), `# x\nexport KS_PROJECT_ROOT_PATH="${checkout}/"\n`)
  assert.equal(ksRoot('ks-zz', f.home, { cwd: f.home }).out, a)
})

test('nested projects: the longest projectPath holding cwd wins', () => {
  const f = fixture()
  const outer = f.mk('p')
  const inner = f.mk('p', 'inner')
  const a = f.plugin(f.mk('a'), 'ks-zz')
  const b = f.plugin(f.mk('b'), 'ks-zz')
  f.installed('ks-zz', [
    { scope: 'local', projectPath: outer, installPath: a },
    { scope: 'local', projectPath: inner, installPath: b },
  ])
  assert.equal(ksRoot('ks-zz', f.home, { cwd: inner }).out, b)
  assert.equal(ksRoot('ks-zz', f.home, { cwd: outer }).out, a)
})

test('an entry whose installPath is gone is skipped', () => {
  const f = fixture()
  const live = f.plugin(f.mk('cache', 'ks-zz', '1.0.6'), 'ks-zz')
  f.installed('ks-zz', [
    { scope: 'local', projectPath: f.home, installPath: join(f.home, 'cache', 'ks-zz', '1.0.7'), version: '1.0.7' },
    { scope: 'user', installPath: live, version: '1.0.6' },
  ])
  assert.equal(ksRoot('ks-zz', f.home).out, live)
})

test("user scope beats other projects' entries; then the highest version", () => {
  const f = fixture()
  const other = f.mk('other')
  const v9 = f.plugin(f.mk('v1.0.9'), 'ks-zz')
  const v10 = f.plugin(f.mk('v1.0.10'), 'ks-zz')
  const user = f.plugin(f.mk('user'), 'ks-zz')
  f.installed('ks-zz', [
    { scope: 'local', projectPath: other, installPath: v9, version: '1.0.9' },
    { scope: 'local', projectPath: other, installPath: v10, version: '1.0.10' },
  ])
  assert.equal(ksRoot('ks-zz', f.home).out, v10)
  f.installed('ks-zz', [
    { scope: 'local', projectPath: other, installPath: v10, version: '1.0.10' },
    { scope: 'user', installPath: user, version: '1.0.0' },
  ])
  assert.equal(ksRoot('ks-zz', f.home).out, user)
})

test('registry: a local entry is used, a marketplace-mode entry is ignored', () => {
  const f = fixture()
  const local = f.mk('clone-zz')
  const cached = f.mk('.claude', 'plugins', 'cache', 'karmasuite', 'ks-zz', '1.0.0')
  f.registry({ 'ks-zz': { root: cached, mode: 'marketplace' } })
  assert.equal(ksRoot('ks-zz', f.home).code, 1)
  f.registry({ 'ks-zz': { root: local, mode: 'local' } })
  assert.equal(ksRoot('ks-zz', f.home).out, local)
  // an installed entry comes first
  const inst = f.plugin(f.mk('inst'), 'ks-zz')
  f.installed('ks-zz', [{ scope: 'user', installPath: inst }])
  assert.equal(ksRoot('ks-zz', f.home).out, inst)
})

test('a sibling plugin folder is found in a clone', () => {
  const f = fixture()
  assert.equal(ksRoot('ks-flow', f.home).out, join(CLONE_PLUGINS, 'ks-flow'))
})

test('ks_root only: claude plugin list (readFromFolder beats installPath, newest wins)', () => {
  const f = fixture()
  const src = f.mk('src')
  const cache = f.mk('cache')
  const bin = f.claude(
    JSON.stringify([
      { id: 'ks-zz@old', installPath: cache, lastUpdated: '2026-01-01' },
      { id: 'ks-zz@karmasuite', installPath: cache, readFromFolder: src, lastUpdated: '2026-02-01' },
      { id: 'other@karmasuite', installPath: cache, lastUpdated: '2026-03-01' },
    ]),
  )
  assert.equal(ksRoot('ks-zz', f.home, { path: `${bin}:${BASE_PATH}` }).out, src)
  // ksr_live_root never asks claude
  assert.equal(sh(`. "${LIB}"; ksr_live_root ks-zz`, [], f.home, { path: `${bin}:${BASE_PATH}` }).code, 1)
})

test('unknown everywhere → exit 1', () => {
  const f = fixture()
  assert.equal(ksRoot('ks-zz', f.home, { env: { KS_CLAUDE_BIN: '/usr/bin/false' } }).code, 1)
})

test('ks_register_root: records a clone, never a cache folder, drops marketplace entries', () => {
  const f = fixture()
  const clone = f.mk('clone', 'ks')
  const cached = f.mk('.claude', 'plugins', 'cache', 'karmasuite', 'ks', '1.0.6')
  f.registry({ 'ks-flow': { root: cached, mode: 'marketplace' }, other: { root: '/x', mode: 'local' } })
  sh(`. "${LIB}"; ks_register_root ks "$1"`, [cached], f.home)
  let reg = JSON.parse(readFileSync(join(f.config, 'plugins.json'), 'utf8'))
  assert.deepEqual(Object.keys(reg), ['other'])
  sh(`. "${LIB}"; ks_register_root ks "$1"`, [clone], f.home)
  reg = JSON.parse(readFileSync(join(f.config, 'plugins.json'), 'utf8'))
  assert.equal(reg.ks.root, clone)
  assert.equal(reg.ks.mode, 'local')
})

test('v2 shim: resolves with no claude on PATH, follows an update, exit 127 when not found', () => {
  const f = fixture()
  const bin = f.mk('local-bin')
  const v6 = f.plugin(f.mk('.claude', 'plugins', 'cache', 'karmasuite', 'ks-zz', '1.0.6'), 'ks-zz')
  f.installed('ks-zz', [{ scope: 'user', installPath: v6, version: '1.0.6' }])
  sh(`. "${LIB}"; ksr_write_shim ks-zz whereami "$1"`, [bin], f.home)
  const shim = join(bin, 'whereami')
  assert.match(readFileSync(shim, 'utf8'), /^# ks-shim v3$/m)
  assert.doesNotMatch(readFileSync(shim, 'utf8'), /1\.0\.6/, 'no baked-in folder')
  const stubs = f.claude()
  const run = () => spawnSync(shim, [], { encoding: 'utf8', cwd: f.home, env: { PATH: `${stubs}:${BASE_PATH}`, HOME: f.home } })
  assert.equal(run().stdout, v6)
  // an update: a new cache folder, the old one stays on disk
  const v7 = f.plugin(f.mk('.claude', 'plugins', 'cache', 'karmasuite', 'ks-zz', '1.0.7'), 'ks-zz')
  f.installed('ks-zz', [{ scope: 'user', installPath: v7, version: '1.0.7' }])
  assert.equal(run().stdout, v7)
  assert.equal(f.claudeCalled(), false, 'the shim never runs claude')
  f.installed('ks-zz', [])
  const r = run()
  assert.equal(r.status, 127)
  assert.match(r.stderr, /run \/ks:setup/)
})

test("the shim hands the caller's stdin to the command, not its folder list (ks-config secret's prompt)", () => {
  const f = fixture()
  const bin = f.mk('local-bin')
  const dir = f.mk('clone', 'plugins', 'ks-zz')
  f.plugin(dir, 'ks-zz')
  // The command reports what it reads on stdin and whether fd 3 is still open.
  writeFileSync(join(dir, 'bin', 'echoin'), '#!/bin/bash\nprintf "in=%s" "$(cat)"\n{ true <&3; } 2>/dev/null && printf " fd3=open"\nexit 0\n')
  chmodSync(join(dir, 'bin', 'echoin'), 0o755)
  f.directoryMarketplace(join(f.home, 'clone'))
  sh(`. "${LIB}"; ksr_write_shim ks-zz echoin "$1"`, [bin], f.home)
  const run = (input: string) =>
    spawnSync(join(bin, 'echoin'), [], { encoding: 'utf8', input, cwd: f.home, env: { PATH: BASE_PATH, HOME: f.home } })
  assert.equal(run('lin_api_secret\n').stdout, 'in=lin_api_secret', 'the piped value, and fd 3 closed')
  assert.equal(run('').stdout, 'in=', 'nothing piped: nothing read (never the folder list)')
})

test('a v3 shim resolves in under 30 ms', () => {
  const f = fixture()
  const bin = f.mk('local-bin')
  const dir = f.mk('clone', 'plugins', 'ks-zz')
  f.plugin(dir, 'ks-zz')
  writeFileSync(join(dir, 'bin', 'noop'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'bin', 'noop'), 0o755)
  f.directoryMarketplace(join(f.home, 'clone'))
  sh(`. "${LIB}"; ksr_write_shim ks-zz noop "$1"`, [bin], f.home)
  // shim (bash + jq + exec) vs the bare command, median of 9 runs each
  const time = (cmd: string) => {
    const ms: number[] = []
    for (let i = 0; i < 9; i++) {
      const t = process.hrtime.bigint()
      const r = spawnSync(cmd, [], { cwd: f.home, env: { PATH: BASE_PATH, HOME: f.home } })
      ms.push(Number(process.hrtime.bigint() - t) / 1e6)
      assert.equal(r.status, 0)
    }
    return ms.sort((a, b) => a - b)[4]
  }
  const overhead = time(join(bin, 'noop')) - time(join(dir, 'bin', 'noop'))
  assert.ok(overhead < 30, `shim resolution took ${overhead.toFixed(1)} ms`)
})

test('ensure-setup.sh rewrites v1 and v2 shims once (ksr_upgrade_shims)', () => {
  const f = fixture()
  const bin = f.mk('.local', 'bin')
  const old = (plug: string, cmd: string) =>
    writeFileSync(
      join(bin, cmd),
      `#!/bin/bash\n# ks shim (ks-setup apply): runs the ${plug} plugin's ${cmd} from wherever the plugin is\n` +
        `# now (the registry follows installs and updates), else from /old.\n` +
        `r="$(jq -r '.["${plug}"].root // empty' "\${KS_CONFIG_DIR:-$HOME/.config/ks}/plugins.json" 2>/dev/null)"\n` +
        `[ -x "$r/bin/${cmd}" ] || r="/old"\nexec "$r/bin/${cmd}" "$@"\n`,
      { mode: 0o755 },
    )
  old('ks', 'ks-root')
  old('ks-flow', 'ks-flow')
  // A v2 shim (the command inherited its folder list as stdin): rewritten too.
  writeFileSync(join(bin, 'ks-config'), '#!/bin/bash\n# ks-shim v2\nn=ks c=ks-config\nwhile IFS= read -r r; do :; done < <(true)\n', { mode: 0o755 })
  writeFileSync(join(bin, 'unrelated'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
  const r = spawnSync('bash', [join(SCRIPTS_DIR, 'ensure-setup.sh')], {
    encoding: 'utf8',
    input: '{}',
    cwd: f.home,
    env: { PATH: BASE_PATH, HOME: f.home, KS_SECURITY_BIN: '/usr/bin/false', KSC_LEGACY_FILES: '', KS_RULES_APPENDED: '1' },
    timeout: 60_000,
  })
  assert.equal(r.status, 0)
  const ksRootShim = readFileSync(join(bin, 'ks-root'), 'utf8')
  assert.match(ksRootShim, /^# ks-shim v3$/m)
  assert.match(ksRootShim, /^n=ks c=ks-root$/m)
  assert.match(readFileSync(join(bin, 'ks-flow'), 'utf8'), /^n=ks-flow c=ks-flow$/m)
  const v2 = readFileSync(join(bin, 'ks-config'), 'utf8')
  assert.match(v2, /^# ks-shim v3$/m)
  assert.match(v2, /^n=ks c=ks-config$/m)
  assert.match(v2, /done 3< <\(jq/)
  assert.equal(readFileSync(join(bin, 'unrelated'), 'utf8'), '#!/bin/sh\necho mine\n')
  // the clone this runs from is recorded as a local root
  const reg = JSON.parse(readFileSync(join(f.config, 'plugins.json'), 'utf8'))
  assert.equal(reg.ks.mode, 'local')
})
