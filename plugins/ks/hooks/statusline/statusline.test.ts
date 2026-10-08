import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { COLORS, formatReset, limitViews, roundHalfEven, usageColor } from './usage'
import { newlyCompleted, parseState, progress } from './workflow'

const ROOT = '/home/u/karmasuite-worktree/jaswanth/kar-13147-map-employee'
const STATE = `${ROOT}/workflow/jaswanth/tickets/kar-13147/state.yaml`

const ticketYaml = (planStatus: string): string => `# yaml-language-server: $schema=/x/ticket-state.schema.json

# Git worktree directory (updated after worktree creation)
worktree_dir: "~/karmasuite-worktree/jaswanth/kar-13147-map-employee"
ticket:
  id: "807574e1"
  identifier: "KAR-13147"
  name: "Map employee fails to assign expenses to the correct BC"
  url: "https://linear.app/karmasuite/issue/KAR-13147/map-employee"
  summary: "Steps:
    name: not a field
    url: not a field"
  status:
    id: "s1"
    name: "In Progress"
slack:
  project_thread:
    url: "https://karmasuite.slack.com/archives/C1/p1"
prs:
  - url: "https://github.com/karmasuite/karmasuite/pull/6321"
    branch: "jaswanth/kar-13147-map-employee"

# Phases tracking
phases:
  - number: 0
    name: "ticket-initialization"
    status: "COMPLETED"
  - number: 1
    name: "context-creation"
    status: "COMPLETED"
  - number: 2
    name: "codebase-research"
    status: "COMPLETED"
  - number: 9
    name: "implementation-plan-creation"
    status: "${planStatus}"
    iterations:
      - started_at: "2026-07-09T13:34:39.000Z"
`

const projectYaml = `worktree_dir: "~/wt/basic-improve"
project:
  id: "58127529"
  name: "[Basic] Improve message"
  url: "https://linear.app/karmasuite/project/basic-improve"
  prd_ticket_id: "KAR-11270"
slack:
  release_thread: null
prs: []
phases:
  - number: 1
    name: "context-creation"
    status: "COMPLETED"
`

test('parses a ticket state.yaml, ignoring look-alike keys in the summary', () => {
  const unit = parseState(ticketYaml('IN_PROGRESS'))
  expect(unit).toEqual({
    kind: 'ticket',
    identifier: 'KAR-13147',
    name: 'Map employee fails to assign expenses to the correct BC',
    url: 'https://linear.app/karmasuite/issue/KAR-13147/map-employee',
    phases: [
      { number: 0, name: 'ticket-initialization', status: 'COMPLETED' },
      { number: 1, name: 'context-creation', status: 'COMPLETED' },
      { number: 2, name: 'codebase-research', status: 'COMPLETED' },
      { number: 9, name: 'implementation-plan-creation', status: 'IN_PROGRESS' },
    ],
  })
})

test('parses a project state.yaml: no identifier, all ten phases', () => {
  const unit = parseState(projectYaml)
  expect(unit?.kind).toBe('project')
  expect(unit?.identifier).toBe(null)
  expect(unit?.url).toBe('https://linear.app/karmasuite/project/basic-improve')
  expect(progress(unit!).cells.map(c => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(progress(unit!).next?.number).toBe(2)
  expect(progress(unit!).isSessionBoundary).toBe(true)
})

test('progress: active phase, then the next one at a session boundary', () => {
  const working = progress(parseState(ticketYaml('IN_PROGRESS'))!)
  expect(working.active?.label).toBe('Plan')
  expect(working.next).toBe(null)

  const planned = progress(parseState(ticketYaml('COMPLETED'))!)
  expect(planned.active).toBe(null)
  expect(planned.next?.number).toBe(10)
  expect(planned.isSessionBoundary).toBe(true)
})

test('newlyCompleted reports only transitions', () => {
  const before = parseState(ticketYaml('IN_PROGRESS'))!.phases
  const after = parseState(ticketYaml('COMPLETED'))!.phases
  expect(newlyCompleted(before, after).map(p => p.number)).toEqual([9])
  expect(newlyCompleted(after, after)).toEqual([])
})

test('reset countdowns read as the shell statusline prints them', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  expect(formatReset(now + (4 * 3600 + 31 * 60) * 1000 + 500, now)).toBe('4h 31m')
  expect(formatReset(now + (86400 + 19 * 3600 + 21 * 60) * 1000, now)).toBe('1d 19h 21m')
  expect(formatReset(now - 1, now)).toBe('now')
})

test('usage color follows projected usage at reset, raw percent early in a window', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const week = 7 * 86400
  // 60% used with 74% of the week gone: on pace for 81% → yellow.
  const reset = now + Math.round(week * 0.26) * 1000
  expect(usageColor(60, reset, week, now)).toEqual({ color: COLORS.yellow, budget: 74 })
  // 5% into the window: too early to project, 10% raw → green.
  expect(usageColor(10, now + Math.round(18000 * 0.95) * 1000, 18000, now)).toEqual({ color: COLORS.green, budget: null })
  expect(usageColor(85, null, 18000, now).color).toBe(COLORS.red)
})

test('percentages round half to even, like the shell statusline printf', () => {
  expect(roundHalfEven(10.5)).toBe(10)
  expect(roundHalfEven(11.5)).toBe(12)
  expect(roundHalfEven(79.5)).toBe(80)
  expect(roundHalfEven(10.4)).toBe(10)
  expect(roundHalfEven(10.6)).toBe(11)
  expect(roundHalfEven(0)).toBe(0)
  // 50.5% rounds to 50 → yellow at the raw threshold, as the shell prints and colors it.
  expect(usageColor(50.5, null, 18000, 0)).toEqual({ color: COLORS.yellow, budget: null })
  // 79.5% rounds to 80 → red at the raw threshold.
  expect(usageColor(79.5, null, 18000, 0).color).toBe(COLORS.red)
  const now = Date.parse('2026-10-07T12:00:00Z')
  expect(limitViews([{ kind: 'five_hour', percentUsed: 12.5 }], now).map(v => v.text)).toEqual(['5h: 12%'])
})

test('an unparsable reset time falls back to the raw percentage with no countdown', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const views = limitViews([{ kind: 'seven_day', percentUsed: 85, resetsAt: 'not-a-date' }], now)
  expect(views).toEqual([{ kind: 'seven_day', text: '7d: 85%', color: COLORS.red, reset: '' }])
  expect(usageColor(30, Number.NaN, 18000, now)).toEqual({ color: COLORS.green, budget: null })
})

test('limitViews shows five-hour then seven-day', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const views = limitViews(
    [
      { kind: 'seven_day', percentUsed: 60, resetsAt: new Date(now + Math.round(7 * 86400 * 0.26) * 1000).toISOString() },
      { kind: 'five_hour', percentUsed: 10 },
    ],
    now,
  )
  expect(views.map(v => [v.text, v.reset])).toEqual([
    ['5h: 10%', ''],
    ['7d: 60%/74%', '(1d 19h 40m)'],
  ])
})

/** The session's start, answered beneath the plugin as the engine would. */
function start(on: On, cwd: string): void {
  on('session.start', () => ({ cwd }))
}

/** Answers git, grep, the file system and the session's figures beneath the plugin. */
function checkout(on: On, yaml: () => string, mtime: () => number, isWorkflowCheckout = true): void {
  mock.env(on, { HOME: '/home/u' })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const stdout = !isWorkflowCheckout
      ? ''
      : argv.startsWith('git rev-parse --show-toplevel')
      ? ROOT
      : argv.startsWith('git rev-parse --abbrev-ref HEAD')
        ? 'jaswanth/kar-13147-map-employee'
        : argv.startsWith('grep ') && argv.includes('worktree_dir: "~/karmasuite-worktree/jaswanth/kar-13147-map-employee"')
          ? `${STATE}\n`
          : ''
    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: mtime(), isLink: false } }))
  on('fs.read', (_$, e) => ({ value: e.path === STATE ? yaml() : '' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 110_400, window: 1_000_000, percent: 11 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10 }],
    },
  }))
}

/** The engine's own hint line, beneath the plugin: what next(e) draws. */
function engineHint(on: On): void {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'bypass permissions on') as RenderElement
  })
}

const HINT = {
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: 'bypass permissions on' },
} as const

test('hint line carries the engine line, then the ticket and phase pills and the limits', async ($, on) => {
  const clock = mock.clock(on)
  let yaml = ticketYaml('IN_PROGRESS')
  let mtime = 1
  checkout(on, () => yaml, () => mtime)
  engineHint(on)
  start(on, ROOT)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ks', surface, ...HINT })
    // The static half (session, context, branch) is scripts/statusline's, not drawn here.
    expect(await ui.find({ type: 'Text', text: '110k/1000k (11%)' })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: 'KAR-13147 ↗' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Plan phase' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● IN PROGRESS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h: 10%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'bypass permissions on' })).toBeDefined()
    await ui.unmount()
  }

  yaml = ticketYaml('COMPLETED')
  mtime = 2
  await clock.advance(6000)

  const ui = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(await ui.find({ type: 'Text', text: 'Implement phase' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◎ NEXT · NEW SESSION' })).toBeDefined()
  await ui.unmount()
})

test('outside a ks workflow checkout the hint line has no workflow pills', async ($, on) => {
  mock.clock(on)
  checkout(on, () => '', () => 1, false)
  engineHint(on)
  start(on, '/tmp')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'ks', surface: 'terminal', ...HINT })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '5h: 10%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'bypass permissions on' })).toBeDefined()
  await ui.unmount()
})
