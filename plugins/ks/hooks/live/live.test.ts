import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { linearStatus, textOn } from './linear'
import { scheduler } from './schedule'
import { branchAlias, deployPill, githubRepo, latestPreview, previewBranch } from './vercel'

test('the scheduler runs each job on its own interval, off one tick', async () => {
  const runs: string[] = []
  let paused = false
  let release: () => void = () => undefined
  const jobs = scheduler({
    fast: { every: () => 5_000, run: async () => void runs.push('fast') },
    slow: { every: () => 60_000, run: async () => void runs.push('slow') },
    paused: { every: () => (paused ? null : 5_000), run: async () => void runs.push('paused') },
    stuck: {
      every: () => 5_000,
      run: () => {
        runs.push('stuck')
        return new Promise<void>(resolve => (release = resolve))
      },
    },
  })

  // Lets started jobs settle (their `finally` frees them); the hooks environment has no setTimeout.
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  paused = true
  for (let now = 0; now <= 60_000; now += 5_000) {
    jobs.tick(now)
    await flush()
  }
  const count = (name: string) => runs.filter(r => r === name).length
  expect(count('fast')).toBe(13)
  // Due at 0 and again at 60s.
  expect(count('slow')).toBe(2)
  expect(count('paused')).toBe(0)
  // Still running: never stacked on itself.
  expect(count('stuck')).toBe(1)

  release()
  await flush()
  jobs.tick(65_000)
  expect(count('stuck')).toBe(2)

  // A kick runs at once, whatever the interval says.
  jobs.kick('slow', 61_000)
  expect(count('slow')).toBe(3)
})

test('linearStatus reads the state, with its color or its type default', () => {
  const json = (state: unknown) => JSON.stringify({ identifier: 'KAR-1', state })
  expect(linearStatus(json({ name: 'In Review', type: 'started', color: '#0f783c' }), 7)).toEqual({
    name: 'In Review',
    type: 'started',
    color: '#0f783c',
    checkedMinute: 7,
  })
  // An older CLI build prints no color: the type's default stands in.
  expect(linearStatus(json({ name: 'Done', type: 'completed' }), 7)?.color).toBe('#5e6ad2')
  expect(linearStatus('Error: LINEAR_API_KEY environment variable is not set', 7)).toBe(null)
  expect(linearStatus(null, 7)).toBe(null)
  expect(textOn('#f2c94c')).toBe('#1c1917')
  expect(textOn('#5e6ad2')).toBe('#ffffff')
})

const BRANCH = 'jaswanth/kar-13147-map-employee'

/** The text list_deployments answers with, as the vercel MCP server sends it. */
function deployments(...list: { ref: string; state: string; created: number; repo?: string }[]): string {
  return JSON.stringify({
    result: {
      deployments: {
        pagination: { count: list.length },
        deployments: list.map((d, i) => ({
          id: `dpl_${i}`,
          url: `karmasuite-${i}.preview.example.com`,
          created: d.created,
          state: d.state,
          target: null,
          meta: { githubCommitRef: d.ref, githubCommitSha: `abc123${i}def`, githubRepo: d.repo ?? 'karmasuite', githubOrg: 'karmasuite' },
          inspectorUrl: `https://vercel.com/karmasuite/karmasuite/${i}`,
        })),
      },
    },
  })
}

test('latestPreview takes the newest deployment of the branch in the repo', () => {
  const text = deployments(
    { ref: BRANCH, state: 'READY', created: 1 },
    { ref: BRANCH, state: 'BUILDING', created: 3 },
    { ref: 'main', state: 'BUILDING', created: 4 },
    { ref: BRANCH, state: 'READY', created: 5, repo: 'other' },
  )
  expect(latestPreview(text, BRANCH, 'karmasuite', 9)).toEqual({
    id: 'dpl_1',
    branch: BRANCH,
    state: 'BUILDING',
    url: 'https://karmasuite-1.preview.example.com',
    branchUrl: null,
    inspectorUrl: 'https://vercel.com/karmasuite/karmasuite/1',
    sha: 'abc1231def',
    createdAt: 3,
    checkedMinute: 9,
  })
  expect(latestPreview(deployments({ ref: 'main', state: 'READY', created: 1 }), BRANCH, 'karmasuite', 9)).toBe(null)
  expect(latestPreview('not json', BRANCH, 'karmasuite', 9)).toBe(null)
})

test('the preview branch is the latest PR branch, else a ticket branch checked out', () => {
  expect(previewBranch(['a', null, 'b'], 'c')).toBe('b')
  expect(previewBranch([], 'jaswanth/kar-1')).toBe('jaswanth/kar-1')
  expect(previewBranch([], 'main')).toBe(null)
  expect(previewBranch([], null)).toBe(null)
  expect(githubRepo('git@github.com:karmasuite/karmasuite.git')).toEqual({ org: 'karmasuite', repo: 'karmasuite' })
  expect(githubRepo('https://github.com/karmasuite/karmasuite')).toEqual({ org: 'karmasuite', repo: 'karmasuite' })
  expect(githubRepo('git@gitlab.com:x/y.git')).toBe(null)
})

/** What list_deployment_aliases answers, as the vercel MCP server sends it. */
const ALIAS = 'karmasuite-git-jaswanth-kar-13147-map-employee.preview.example.com'
const aliases = (...names: string[]) => JSON.stringify({ result: { aliases: names.map((alias, i) => ({ uid: `u${i}`, alias, redirect: null })) } })

test('branchAlias picks the branch alias, the one that follows every build', () => {
  expect(branchAlias(aliases('custom.example.com', ALIAS))).toBe(`https://${ALIAS}`)
  expect(branchAlias(aliases('only.example.com'))).toBe('https://only.example.com')
  expect(branchAlias(aliases())).toBe(null)
  expect(branchAlias('not json')).toBe(null)
})

test('the deploy pill says where the preview stands and links where it helps', () => {
  const at = (state: string, branchUrl: string | null = 'https://b') =>
    deployPill({ id: 'dpl_1', branch: BRANCH, state, url: 'https://p', branchUrl, inspectorUrl: 'https://i', sha: null, createdAt: 0, checkedMinute: 0 })
  expect(at('BUILDING')).toMatchObject({ text: '▲ DEPLOYING', href: 'https://i' })
  // Ready: the branch's stable alias, else this build's own URL.
  expect(at('READY')).toMatchObject({ text: '▲ PREVIEW', href: 'https://b' })
  expect(at('READY', null)).toMatchObject({ text: '▲ PREVIEW', href: 'https://p' })
  expect(at('ERROR')).toMatchObject({ text: '▲ PREVIEW FAILED', href: 'https://i' })
  expect(at('CANCELED')).toMatchObject({ text: '▲ CANCELED' })
})

// The mod end to end: a ks ticket checkout, Linear and Vercel answered beneath the plugin.

const ROOT = '/home/u/wt/kar-13147-map-employee'
const STATE = `${ROOT}/workflow/jaswanth/tickets/kar-13147/state.yaml`

const ticketDoc = {
  worktree_dir: '~/wt/kar-13147-map-employee',
  ticket: { identifier: 'KAR-13147', name: 'Map employee', url: 'https://linear.app/karmasuite/issue/KAR-13147/x', status: { name: 'In Progress' } },
  prs: [{ url: 'https://github.com/karmasuite/karmasuite/pull/6724', branch: BRANCH }],
  phases: [{ number: 9, name: 'implementation-plan-creation', status: 'IN_PROGRESS' }],
}

const LINEAR_JSON = JSON.stringify({ identifier: 'KAR-13147', state: { name: 'In Review', type: 'started', color: '#0f783c' } })

/** `mcp` answers list_deployments; 'missing' fails as an engine without the vercel plugin does. */
function checkout(
  on: On,
  mcp: (() => string) | 'missing',
  timeLog: () => string = () => '',
): { mcpCalls: () => number; aliasCalls: () => number } {
  let calls = 0
  let aliasCalls = 0
  mock.env(on, { HOME: '/home/u' })
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const stdout = argv.startsWith('git rev-parse --show-toplevel')
      ? ROOT
      : argv.startsWith('git rev-parse --abbrev-ref HEAD')
        ? BRANCH
        : argv.startsWith('git remote get-url origin')
          ? 'git@github.com:karmasuite/karmasuite.git'
          : argv.startsWith('grep ')
            ? `${STATE}\n`
            : argv.startsWith('date ')
              ? '+0530'
              : e.argv[0] === 'node'
                ? JSON.stringify(ticketDoc)
                : argv.includes('linear-cli.ts issue get KAR-13147 --json')
                  ? LINEAR_JSON
                  : ''
    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_$, e) => ({
    value: e.path === STATE
      ? 'ticket:\n  identifier: "KAR-13147"\n  url: "https://linear.app/x"\nphases:\n  - number: 9\n    name: "implementation-plan-creation"\n    status: "IN_PROGRESS"\n'
      : e.path === '/home/u/.claude/ks-time/KAR-13147.jsonl'
        ? timeLog()
        : '',
  }))
  on('fs.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('mcp.call', (_$, e) => {
    if (mcp === 'missing') {
      calls++
      throw new Error('no MCP server named plugin:vercel:vercel')
    }
    if (e.tool === 'list_deployment_aliases') {
      aliasCalls++
      return { value: { content: [{ type: 'text' as const, text: aliases(ALIAS) }], isError: false } }
    }
    calls++
    return { value: { content: [{ type: 'text' as const, text: mcp() }], isError: false } }
  })
  // The engine's own hint line, beneath the plugin.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'bypass permissions on') as RenderElement
  })
  return { mcpCalls: () => calls, aliasCalls: () => aliasCalls }
}

const HINT = {
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '' },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'ks-project',
  props: { title: 'KAR-13147', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const label = async (ui: { find: (q: { key: string }) => Promise<unknown> }) => JSON.stringify(await ui.find({ key: 'open-project' }))

test('the statusline shows the preview deploy and toggles the pane; the pane shows Linear live', async ($, on) => {
  const clock = mock.clock(on)
  let state = 'BUILDING'
  // An ended session in the Plan phase: a 5m turn, then 1m reading → 6m engaged.
  const t0 = clock.now()
  const line = (min: number, event: string) => JSON.stringify({ ts: t0 - min * 60_000, event, session: 's1', phase: '9' })
  const timeLog = [line(30, 'UserPromptSubmit'), line(25, 'Stop'), line(24, 'SessionEnd')].join('\n')
  const vercel = checkout(on, () => deployments({ ref: BRANCH, state, created: 1 }), () => timeLog)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)

  const hint = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(await hint.find({ type: 'Text', text: '▲ DEPLOYING' })).toBeDefined()
  expect(await label(hint)).toContain('≡ more')

  // Building: polled every 10s.
  const before = vercel.mcpCalls()
  await clock.advance(10_000)
  expect(vercel.mcpCalls()).toBeGreaterThan(before)

  state = 'READY'
  await clock.advance(10_000)
  // The pill opens the branch's alias, not this build's own URL.
  expect(JSON.stringify(await hint.find({ type: 'Link', text: '▲ PREVIEW ↗' }))).toContain(ALIAS)
  // Asked for once: the alias is the branch's for good.
  expect(vercel.aliasCalls()).toBe(1)
  // Ready: back to every 2 minutes.
  const settled = vercel.mcpCalls()
  await clock.advance(60_000)
  expect(vercel.mcpCalls()).toBe(settled)

  await hint.press({ key: 'open-project' })
  expect(await label(hint)).toContain('≡ less')

  const pane = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'In Review' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).toMatch(/ live · \d{1,2}:\d\d (AM|PM)/)
  // The phase being worked shows the time spent on it, from the time log.
  expect(await pane.find({ type: 'Text', text: 'in progress  (6m engaged)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'PREVIEW DEPLOY' })).toBeDefined()
  expect(JSON.stringify(await pane.find({ type: 'Link', text: 'open preview ↗' }))).toContain(ALIAS)
  expect(await pane.find({ type: 'Text', text: BRANCH })).toBeDefined()
  await pane.unmount()

  await hint.press({ key: 'open-project' })
  expect(await label(hint)).toContain('≡ more')
  await hint.unmount()
})

test('without the vercel plugin the deploy pill and section stay hidden, and it stops asking', async ($, on) => {
  const clock = mock.clock(on)
  const vercel = checkout(on, 'missing')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  const asked = vercel.mcpCalls()
  expect(asked).toBe(1)
  await clock.advance(300_000)
  expect(vercel.mcpCalls()).toBe(asked)

  const hint = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(await hint.find({ type: 'Link', text: 'KAR-13147 ↗' })).toBeDefined()
  expect(JSON.stringify(await hint.drawn())).not.toContain('▲')
  await hint.unmount()

  const pane = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'PREVIEW DEPLOY' })).toBeUndefined()
  await pane.unmount()
})
