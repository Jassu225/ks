import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import {
  AUTO_RELOAD_ARGS,
  AUTO_RELOAD_CHECK_IN_MS,
  AUTO_RELOAD_COMMAND,
  AUTO_RELOAD_MAX_REFUSALS,
  AUTO_RELOAD_PROMPT_GAP_TICKS,
  AUTO_RELOAD_STORE_RETRY_MS,
  AutoReload,
  hidesReloadOutput,
  readAutoReloads,
  STORE_AUTO_RELOAD,
  type AutoReloadDeps,
  type LoadedPluginInfo,
} from './auto-reload'
import { chooseInstalled, liveRoot, projectPathFromEnvFile, reloadOffer, targetOf, type RootContext, type RootFs } from './installed'

// The KS plugins reload themselves after an update (a port of Plannotator's
// auto reload). The failures these catch: a reload while a main turn runs or
// a prompt is on its way in; a reload over text the person typed; a second
// reload for the same target (a reload that loaded nothing new must not
// loop); a refused run retried without the person's input, or forever; a
// store that fails letting a run through; the new module not checking in; no
// manual notice once it gives up; and the folder lookup picking a stale
// cache entry over a directory marketplace.

const SESSION = 'sess-1'
const OLD = 'ks@1.0.6,ks-flow@0.2.2'
const NEW = 'ks@1.0.7,ks-flow@0.2.2'

function deps(overrides: Partial<AutoReloadDeps> = {}) {
  const store = new Map<string, unknown>()
  const timers: { at: number; fn: () => void }[] = []
  const gaveUp: string[] = []
  const state = {
    clock: 1_000_000,
    busy: null as string | null,
    box: '',
    runs: 0,
    runError: null as Error | null,
    loaded: { version: OLD, root: '/home/u/git/ks/plugins/ks', loaded_at: 999_000 } as LoadedPluginInfo,
  }
  const d: AutoReloadDeps = {
    sessionId: SESSION,
    now: async () => state.clock,
    storeGet: async key => store.get(key),
    storeSet: async (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)))
    },
    loaded: async () => state.loaded,
    promptText: async () => state.box,
    busyReason: () => state.busy,
    run: async () => {
      state.runs += 1
      if (state.runError) throw state.runError
    },
    after: (ms, fn) => {
      timers.push({ at: state.clock + ms, fn })
    },
    debug: () => undefined,
    gaveUp: target => {
      gaveUp.push(target)
    },
    // One module's memory per deps(): a test that reloads the module gives the new one a fresh map.
    attempts: new Map(),
    ...overrides,
  }
  const elapse = async (ms: number) => {
    state.clock += ms
    for (const timer of timers.filter(t => t.at <= state.clock)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  const record = () => readAutoReloads(store.get(STORE_AUTO_RELOAD))[SESSION] ?? null
  return { d, state, store, elapse, record, gaveUp }
}

describe('the auto reload', () => {
  test('runs only when a reload loads another target, and once per target', async () => {
    const { d, state, record } = deps()
    const reload = new AutoReload(d)
    await reload.tick()
    reload.setOffer(null)
    await reload.tick()
    expect(state.runs).toBe(0)
    reload.setOffer(NEW)
    await reload.tick()
    await reload.tick()
    expect(state.runs).toBe(1)
    expect(record()).toMatchObject({ version: NEW, outcome: 'pending', from: { version: OLD } })
  })

  test('never while a turn runs: it waits for the next idle moment', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    reload.setOffer(NEW)
    state.busy = 'a turn runs'
    await reload.tick()
    expect(state.runs).toBe(0)
    state.busy = null
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('never over text in the prompt box; whitespace alone counts as empty', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    reload.setOffer(NEW)
    state.box = 'half a thought'
    await reload.tick()
    expect(state.runs).toBe(0)
    state.box = '\n'
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('a prompt inside prompt.submit holds it with no limit; one that entered as a new turn, until its turn starts or the gap passes', async () => {
    const { d, state } = deps()
    const reload = new AutoReload(d)
    reload.setOffer(NEW)
    reload.notePromptSubmitting()
    for (let i = 0; i < AUTO_RELOAD_PROMPT_GAP_TICKS + 10; i += 1) await reload.tick()
    expect(state.runs).toBe(0)
    // It entered as a new turn: held until its turn.start …
    reload.notePromptLeft('new-turn')
    await reload.tick()
    expect(state.runs).toBe(0)
    reload.onInputMoved()
    await reload.tick()
    expect(state.runs).toBe(1)

    // … or let go after the gap (a slash command that starts no turn).
    const other = deps()
    const second = new AutoReload(other.d)
    second.setOffer(NEW)
    second.notePromptSubmitting()
    second.notePromptLeft('new-turn')
    for (let i = 0; i < AUTO_RELOAD_PROMPT_GAP_TICKS; i += 1) await second.tick()
    expect(other.state.runs).toBe(0)
    await second.tick()
    expect(other.state.runs).toBe(1)
  })

  test('a reload that did not replace the module is not tried again, and gives up to the manual notice', async () => {
    const { d, state, elapse, record, gaveUp } = deps()
    const reload = new AutoReload(d)
    reload.setOffer(NEW)
    await reload.tick()
    expect(record()?.outcome).toBe('pending')
    expect(gaveUp).toEqual([])
    await elapse(AUTO_RELOAD_CHECK_IN_MS)
    expect(record()?.outcome).toBe('did_not_take')
    expect(gaveUp).toEqual([NEW])
    for (let i = 0; i < 5; i += 1) {
      await elapse(5_000)
      await reload.tick()
    }
    expect(state.runs).toBe(1)
    // A newer release is a new target: one more try.
    reload.setOffer('ks@1.0.8,ks-flow@0.2.2')
    await reload.tick()
    expect(state.runs).toBe(2)
  })

  test('a refused run is tried again only after a turn starts, at most three times, then the notice', async () => {
    const { d, state, record, gaveUp } = deps()
    state.runError = new Error('the session was stopped and nobody has sent input since')
    const reload = new AutoReload(d)
    reload.setOffer(NEW)
    await reload.tick()
    await reload.tick()
    expect(state.runs).toBe(1)
    expect(record()).toMatchObject({ outcome: 'refused', refusals: 1 })
    expect(gaveUp).toEqual([])
    for (let i = 0; i < AUTO_RELOAD_MAX_REFUSALS + 3; i += 1) {
      reload.onInputMoved()
      await reload.tick()
    }
    expect(state.runs).toBe(AUTO_RELOAD_MAX_REFUSALS)
    expect(gaveUp).toEqual([NEW])
  })

  test('a store that refuses writes runs nothing, gives up to the notice, and tries the store again only after a while', async () => {
    const { d, state, elapse, gaveUp } = deps()
    let sets = 0
    const reload = new AutoReload({
      ...d,
      storeSet: async () => {
        sets += 1
        throw new Error('the store is over 4 MiB')
      },
    })
    reload.setOffer(NEW)
    for (let i = 0; i < 5; i += 1) {
      await reload.tick()
      await elapse(5_000)
    }
    expect(state.runs).toBe(0)
    expect(sets).toBe(1)
    expect(gaveUp).toEqual([NEW])
    await elapse(AUTO_RELOAD_STORE_RETRY_MS)
    await reload.tick()
    expect(sets).toBe(2)
    expect(state.runs).toBe(0)
  })

  test('a turn that starts while the record is written stops the run, and the record is put back', async () => {
    const { d, state, record } = deps()
    let writes = 0
    const reload = new AutoReload({
      ...d,
      storeSet: async (key, value) => {
        await d.storeSet(key, value)
        if ((writes += 1) === 1) state.busy = 'a turn runs'
      },
    })
    reload.setOffer(NEW)
    await reload.tick()
    expect(state.runs).toBe(0)
    expect(record()).toBeNull()
    state.busy = null
    await reload.tick()
    expect(state.runs).toBe(1)
  })

  test('the new module checks in after the reload: checked_in when it loaded the target, did_not_take when not', async () => {
    const { d, state, store, elapse, record } = deps()
    const old = new AutoReload(d)
    old.setOffer(NEW)
    await old.tick()
    expect(state.runs).toBe(1)
    // The reload: a new module, loaded 2 s later with the new versions, fresh memory, the same store.
    await elapse(2_000)
    old.dispose()
    const fresh = new AutoReload({ ...d, attempts: new Map(), loaded: async () => ({ version: NEW, root: null, loaded_at: state.clock }) })
    expect(await fresh.checkIn()).toMatchObject({ outcome: 'checked_in', checkedIn: { version: NEW } })
    expect(record()?.outcome).toBe('checked_in')
    // It is up to date: no offer, nothing runs.
    fresh.setOffer(null)
    await fresh.tick()
    expect(state.runs).toBe(1)
    // The disposed old module's timer never writes over it.
    await elapse(AUTO_RELOAD_CHECK_IN_MS)
    expect(record()?.outcome).toBe('checked_in')

    // A reload that loaded the old code again.
    const other = deps()
    const before = new AutoReload(other.d)
    before.setOffer(NEW)
    await before.tick()
    before.dispose()
    await other.elapse(1_000)
    const same = new AutoReload({ ...other.d, attempts: new Map(), loaded: async () => ({ version: OLD, root: null, loaded_at: other.state.clock }) })
    expect((await same.checkIn())?.outcome).toBe('did_not_take')
    // Its first look gives up to the notice and runs nothing.
    same.setOffer(NEW)
    await same.tick()
    expect(other.state.runs).toBe(1)
    expect(other.gaveUp).toEqual([NEW])
    expect(store.size).toBe(1)
  })

  test('the record outlives the module: a fresh module for the same session does not run again for that target', async () => {
    const { d, state } = deps()
    const first = new AutoReload(d)
    first.setOffer(NEW)
    await first.tick()
    const second = new AutoReload({ ...d, attempts: new Map() })
    second.setOffer(NEW)
    await second.tick()
    expect(state.runs).toBe(1)
  })

  test('only a plain success of `/reload-plugins ks` is hidden', () => {
    const ok = { command: AUTO_RELOAD_COMMAND, args: AUTO_RELOAD_ARGS, text: 'Reloaded: 6 plugins · 12 skills', isErrored: false }
    expect(hidesReloadOutput(ok)).toBe(true)
    expect(hidesReloadOutput({ ...ok, args: '' })).toBe(false)
    expect(hidesReloadOutput({ ...ok, isErrored: true })).toBe(false)
    expect(hidesReloadOutput({ ...ok, text: 'Reloaded: 6 plugins. Run /reload-plugins --force to apply MCP changes' })).toBe(false)
    expect(hidesReloadOutput({ ...ok, text: 'Could not reload' })).toBe(false)
  })
})

// The folder lookup (installed.ts), over an in-memory file system.

function memFs(files: Record<string, string>, dirs: string[]): RootFs {
  return {
    read: async path => files[path] ?? null,
    isDir: async path => dirs.includes(path),
  }
}

const HOME = '/home/u'
const pluginJson = (name: string, version: string) => JSON.stringify({ name, version })
const DIRECTORY_MARKETS = JSON.stringify({ karmasuite: { source: { source: 'directory', path: `${HOME}/git/ks` }, installLocation: `${HOME}/git/ks` } })
const GITHUB_MARKETS = JSON.stringify({ karmasuite: { source: { source: 'github', repo: 'x/ks' }, installLocation: `${HOME}/.claude/plugins/marketplaces/karmasuite` } })
const CACHE = `${HOME}/.claude/plugins/cache/karmasuite`

function installed(entries: Record<string, unknown[]>): string {
  return JSON.stringify({ version: 2, plugins: entries })
}

function ctx(files: Record<string, string>, dirs: string[], cwd = `${HOME}/kar/wt/a`, projectPath?: string | null): RootContext {
  return { home: HOME, configDir: `${HOME}/.config/ks`, claudeDir: `${HOME}/.claude`, cwd, projectPath, pluginsDir: null, env: {}, fs: memFs(files, dirs) }
}

describe('the live plugin folder', () => {
  test('a directory marketplace beats a stale cache entry', async () => {
    const files = {
      [`${HOME}/.claude/plugins/known_marketplaces.json`]: DIRECTORY_MARKETS,
      [`${HOME}/.claude/plugins/installed_plugins.json`]: installed({ 'ks@karmasuite': [{ scope: 'user', installPath: `${CACHE}/ks/1.0.0`, version: '1.0.0' }] }),
      [`${HOME}/git/ks/plugins/ks/.claude-plugin/plugin.json`]: pluginJson('ks', '1.0.6'),
    }
    expect(await liveRoot('ks', ctx(files, [`${HOME}/git/ks/plugins/ks`, `${CACHE}/ks/1.0.0`]))).toBe(`${HOME}/git/ks/plugins/ks`)
  })

  test("the cwd's entry beats the checkout's; a missing installPath is skipped", async () => {
    const entries = [
      { scope: 'local', projectPath: `${HOME}/kar/main`, installPath: `${CACHE}/ks/1.0.6`, version: '1.0.6' },
      { scope: 'local', projectPath: `${HOME}/kar/wt/a`, installPath: `${CACHE}/ks/1.0.7`, version: '1.0.7' },
      { scope: 'local', projectPath: `${HOME}/kar/wt/b`, installPath: `${CACHE}/ks/gone`, version: '1.0.9' },
    ]
    const files = {
      [`${HOME}/.claude/plugins/known_marketplaces.json`]: GITHUB_MARKETS,
      [`${HOME}/.claude/plugins/installed_plugins.json`]: installed({ 'ks@karmasuite': entries }),
      [`${HOME}/.config/ks/ks.env`]: `KS_PROJECT_ROOT_PATH="${HOME}/kar/main"\n`,
    }
    const dirs = [`${CACHE}/ks/1.0.6`, `${CACHE}/ks/1.0.7`]
    expect(await liveRoot('ks', ctx(files, dirs, `${HOME}/kar/wt/a/src`))).toBe(`${CACHE}/ks/1.0.7`)
    // Elsewhere: the KS checkout's entry (from ks.env).
    expect(await liveRoot('ks', ctx(files, dirs, '/tmp'))).toBe(`${CACHE}/ks/1.0.6`)
    // wt/b's entry is gone: the checkout's.
    expect(await liveRoot('ks', ctx(files, dirs, `${HOME}/kar/wt/b`))).toBe(`${CACHE}/ks/1.0.6`)
  })

  test('a marketplace-mode registry entry is ignored; a clone (local) one counts', async () => {
    const reg = (mode: string) => ({ [`${HOME}/.config/ks/plugins.json`]: JSON.stringify({ 'ks-flow': { root: `${HOME}/clone/ks-flow`, mode } }) })
    const dirs = [`${HOME}/clone/ks-flow`]
    expect(await liveRoot('ks-flow', ctx(reg('marketplace'), dirs))).toBeNull()
    expect(await liveRoot('ks-flow', ctx(reg('local'), dirs))).toBe(`${HOME}/clone/ks-flow`)
  })

  test('KS_PROJECT_ROOT_PATH from ks.env, and entry choice by scope', () => {
    expect(projectPathFromEnvFile("export KS_PROJECT_ROOT_PATH='~/kar/main'\n", HOME)).toBe(`${HOME}/kar/main`)
    const user = { scope: 'user', installPath: '/u', version: '1.0.5' }
    const newer = { scope: 'local', projectPath: '/elsewhere', installPath: '/l', version: '1.0.9' }
    expect(chooseInstalled([user, newer], '/tmp', null)).toBe(user)
    expect(chooseInstalled([newer], '/tmp', null)).toBe(newer)
  })

  test('the offer names every plugin as it is now, when one changed', () => {
    const names = ['ks', 'ks-flow']
    const loaded = { ks: { root: '/a', version: '1.0.6' }, 'ks-flow': { root: '/b', version: '0.2.2' } }
    expect(reloadOffer(loaded, loaded, names)).toBeNull()
    const now = { ks: { root: '/a', version: '1.0.6' }, 'ks-flow': { root: '/b', version: '0.3.0' } }
    expect(reloadOffer(loaded, now, names)).toEqual({ target: 'ks@1.0.6,ks-flow@0.3.0', changed: [{ plugin: 'ks-flow', from: '0.2.2', to: '0.3.0' }] })
    // Unknown on either side: not compared.
    expect(reloadOffer(loaded, { ks: { root: '/a', version: '1.0.6' }, 'ks-flow': { root: null, version: null } }, names)).toBeNull()
    expect(targetOf(loaded, names)).toBe('ks@1.0.6,ks-flow@0.2.2')
  })
})

// The mod end to end: a clone loaded as the karmasuite directory marketplace.

const CLONE = `${HOME}/git/ks`

function dirMarketplace(on: On, versions: { ks: string; flow: string }, box: { text: string }) {
  const runs: { command: string; args: string }[] = []
  const refuse = { error: null as string | null }
  const usage = { calls: 0 }
  mock.env(on, { HOME })
  mock.store(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.start', () => ({ cwd: `${HOME}/kar/main` }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // No ks checkout here: no workflow, so only the reload and the limits draw.
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_$, e) => ({
    value: { kind: e.path === `${CLONE}/plugins/ks` || e.path === `${CLONE}/plugins/ks-flow` ? ('dir' as const) : ('other' as const), size: 1, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_$, e) => {
    const path = e.path
    // The ks plugin's own plugin.json, wherever the test host loaded it from, and the clone's.
    const value = path === `${HOME}/.claude/plugins/known_marketplaces.json`
      ? DIRECTORY_MARKETS
      : path.endsWith('/ks/.claude-plugin/plugin.json')
        ? pluginJson('ks', versions.ks)
        : path === `${CLONE}/plugins/ks-flow/.claude-plugin/plugin.json`
          ? pluginJson('ks-flow', versions.flow)
          : ''
    return { value }
  })
  on('session.usage', () => {
    usage.calls += 1
    return { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('command.run', (_$, e) => {
    runs.push({ command: e.command, args: e.args })
    if (refuse.error) throw new Error(refuse.error)
    return { text: 'Reloaded: 6 plugins' }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'bypass permissions on') as RenderElement
  })
  return { runs, refuse, usage }
}

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } } as const

test('in a clone, a plugin.json version change reloads the plugins once, never while a turn runs or the box holds text', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const versions = { ks: '1.0.6', flow: '0.2.2' }
  const box = { text: '' }
  const { runs } = dirMarketplace(on, versions, box)
  await $.session.start({ cwd: `${HOME}/kar/main`, surface: 'terminal', isInteractive: true })
  // Up to date: a few minutes go by, nothing runs.
  await clock.advance(180_000)
  expect(runs).toHaveLength(0)

  // An update lands while a turn runs (the box is empty).
  versions.flow = '0.3.0'
  await $.turn.start({ turnId: 't1', text: 'work' })
  await clock.advance(120_000)
  expect(runs).toHaveLength(0)
  // A subagent's end does not end the main turn.
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(10_000)
  expect(runs).toHaveLength(0)
  // The turn ends with text in the box: still nothing.
  box.text = 'half a thought'
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(10_000)
  expect(runs).toHaveLength(0)
  // The box is cleared: it runs, once.
  box.text = ''
  await clock.advance(10_000)
  expect(runs).toEqual([{ command: AUTO_RELOAD_COMMAND, args: AUTO_RELOAD_ARGS }])
  await clock.advance(120_000)
  expect(runs).toHaveLength(1)

  // The reload did not replace the module (the test host keeps it): the manual notice.
  const hint = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(JSON.stringify(await hint.find({ key: 'reload-pill' }))).toContain('ks-flow 0.3.0')
  expect(JSON.stringify(await hint.drawn())).toContain('run /reload-plugins')
  await hint.unmount()
})

test('a run the engine refuses three times gives up to the notice', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const versions = { ks: '2.0.0', flow: '0.9.0' }
  const box = { text: '' }
  const { runs, refuse } = dirMarketplace(on, versions, box)
  refuse.error = 'a Stop stands'
  await $.session.start({ cwd: `${HOME}/kar/main`, surface: 'terminal', isInteractive: true })
  await clock.advance(70_000)
  versions.ks = '2.0.1'
  await clock.advance(70_000)
  expect(runs).toHaveLength(1)
  // Held for the person's input: no retry until a turn starts.
  await clock.advance(60_000)
  expect(runs).toHaveLength(1)
  for (let i = 0; i < AUTO_RELOAD_MAX_REFUSALS + 1; i += 1) {
    await $.turn.start({ turnId: `t${i}`, text: 'go' })
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
    await clock.advance(10_000)
  }
  expect(runs).toHaveLength(AUTO_RELOAD_MAX_REFUSALS)
  const hint = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(JSON.stringify(await hint.find({ key: 'reload-pill' }))).toContain('ks 2.0.1')
  await hint.unmount()
})

test('the plain "Reloaded" row of `/reload-plugins ks` draws as nothing; a warning still shows', async ($, on) => {
  mock.clock(on)
  dirMarketplace(on, { ks: '1.0.6', flow: '0.2.2' }, { text: '' })
  // The engine's own row, beneath the plugin.
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text) as RenderElement
  })
  await $.session.start({ cwd: `${HOME}/kar/main`, surface: 'terminal', isInteractive: true })
  const row = (text: string) => ({ component: 'CommandOutput', props: { command: AUTO_RELOAD_COMMAND, args: AUTO_RELOAD_ARGS, text, isErrored: false } }) as const
  const plain = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...row('Reloaded: 6 plugins · 12 skills') })
  expect(JSON.stringify(await plain.drawn())).not.toContain('Reloaded')
  await plain.unmount()
  const warned = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...row('Reloaded: 6 plugins. Run /reload-plugins --force to apply MCP changes') })
  expect(JSON.stringify(await warned.drawn())).toContain('--force')
  await warned.unmount()
})

test('a second session.start (a /clear) leaves one clock running: each job keeps its own rate', async ($, on) => {
  const clock = mock.clock(on)
  const { usage } = dirMarketplace(on, { ks: '1.0.6', flow: '0.2.2' }, { text: '' })
  await $.session.start({ cwd: `${HOME}/kar/main`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  await $.session.start({ cwd: `${HOME}/kar/main`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  // The usage job reads the figures every 5 s: ten times in 50 s, not twenty (two timers, two schedulers).
  const before = usage.calls
  await clock.advance(50_000)
  expect(usage.calls - before).toBe(10)
})
