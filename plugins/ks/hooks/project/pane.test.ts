import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatClock, formatWhen, projectInfo, workflowLabel } from './info'
import { PULSE_FRAMES, pulseCell, pulseColor } from './pulse'

const ROOT = '/home/u/wt/kar-13147-map-employee'
const DIR = `${ROOT}/workflow/jaswanth/tickets/kar-13147`
const STATE = `${DIR}/state.yaml`

/** state.yaml as the yaml package parses it. */
const ticketDoc = {
  worktree_dir: '~/wt/kar-13147-map-employee',
  ticket: {
    identifier: 'KAR-13147',
    name: 'Map employee fails to assign expenses to the correct BC',
    url: 'https://linear.app/karmasuite/issue/KAR-13147/map-employee',
    dates: { created_at: '2026-10-07T01:00:00Z', updated_at: '2026-10-07T02:00:00Z', due_date: '2026-10-10' },
    priority: { value: 1, name: 'Urgent' },
    status: { id: 's', name: 'In Progress' },
    labels: [{ id: 'l', name: 'Bug' }],
    assignee: { id: 'a', name: 'Jaswanth' },
    estimate: 1,
    parent_project: { id: 'p', name: 'EGL', url: 'https://linear.app/karmasuite/project/egl' },
  },
  slack: {
    project_thread: { channel_id: 'C1', channel_name: 'engineering', ts: '1.2', url: 'https://karmasuite.slack.com/archives/C1/p12' },
    release_thread: null,
  },
  prs: [
    {
      url: 'https://github.com/karmasuite/karmasuite/pull/6724',
      branch: 'jaswanth/kar-13147-map-employee',
      created_at: '2026-10-07T10:10:40Z',
      review_thread: { channel_id: 'C1', channel_name: '#engineering', ts: '3.4', url: 'https://karmasuite.slack.com/archives/C1/p34' },
    },
  ],
  phases: [
    { number: 0, name: 'ticket-initialization', status: 'COMPLETED' },
    { number: 1, name: 'context-creation', status: 'COMPLETED', started_at: '2026-10-07T06:22:18Z', ended_at: '2026-10-07T06:46:58Z' },
    {
      number: 9,
      name: 'implementation-plan-creation',
      status: 'IN_PROGRESS',
      iterations: [{ started_at: '2026-10-07T13:34:39Z', ended_at: '2026-10-08T07:45:50Z' }, { started_at: '2026-10-08T09:00:00Z' }],
    },
  ],
}

const CTX = { workflowDir: DIR }

test('projectInfo reads the ticket, threads, PRs and phases', () => {
  const info = projectInfo(ticketDoc, CTX)!
  expect(info).toMatchObject({
    kind: 'ticket',
    identifier: 'KAR-13147',
    status: 'In Progress',
    priority: 'Urgent',
    estimate: 1,
    owner: { role: 'Assignee', name: 'Jaswanth' },
    dueDate: '2026-10-10',
    labels: ['Bug'],
    parentProject: { name: 'EGL', url: 'https://linear.app/karmasuite/project/egl' },
    worktree: '~/wt/kar-13147-map-employee',
  })
  // A null thread is left out; channel names get one leading #.
  expect(info.threads).toEqual([{ label: 'Project thread', channel: '#engineering', url: 'https://karmasuite.slack.com/archives/C1/p12' }])
  expect(info.prs).toEqual([
    {
      url: 'https://github.com/karmasuite/karmasuite/pull/6724',
      number: '6724',
      branch: 'jaswanth/kar-13147-map-employee',
      createdAt: '2026-10-07T10:10:40Z',
      reviewThread: { label: 'Review', channel: '#engineering', url: 'https://karmasuite.slack.com/archives/C1/p34' },
    },
  ])
  // Phase 0 is left out; an iterated phase spans its first start to its last end.
  expect(info.phases.map(p => [p.label, p.status, p.startedAt, p.endedAt, p.iterations])).toEqual([
    ['Context', 'COMPLETED', '2026-10-07T06:22:18Z', '2026-10-07T06:46:58Z', 0],
    ['Plan', 'IN_PROGRESS', '2026-10-07T13:34:39Z', null, 2],
  ])
})

test('projectInfo reads a project: lead, initiatives, phase tickets, list threads', () => {
  const info = projectInfo(
    {
      project: {
        name: '[Basic] Improve message',
        url: 'https://linear.app/karmasuite/project/basic-improve',
        lead: { id: 'l', name: 'Ana' },
        initiatives: [{ id: 'i', name: 'Q4 polish' }],
        prd_ticket_id: 'KAR-11270',
        tad_ticket_id: null,
      },
      slack: {
        project_thread: { channel_id: 'C', channel_name: 'proj', ts: '1' },
        pr_review_threads: [
          { channel_id: 'C', channel_name: 'eng', ts: '2', url: 'https://s/2' },
          { channel_id: 'C', channel_name: 'eng', ts: '3', url: 'https://s/3' },
        ],
      },
      phases: [],
    },
    { workflowDir: '/w' },
  )!
  expect(info.identifier).toBe(null)
  expect(info.owner).toEqual({ role: 'Lead', name: 'Ana' })
  expect(info.initiatives).toEqual(['Q4 polish'])
  expect(info.relatedTickets).toEqual([
    { label: 'PRD', identifier: 'KAR-11270', url: 'https://linear.app/karmasuite/issue/KAR-11270' },
  ])
  expect(info.threads.map(t => [t.label, t.channel, t.url])).toEqual([
    ['Project thread', '#proj', null],
    ['PR review 1', '#eng', 'https://s/2'],
    ['PR review 2', '#eng', 'https://s/3'],
  ])
})

test('projectInfo refuses a file that is neither ticket nor project', () => {
  expect(projectInfo({ phases: [] }, CTX)).toBe(null)
  expect(projectInfo('not yaml', CTX)).toBe(null)
})

test('workflowLabel shows the folder from workflow/ on', () => {
  expect(workflowLabel(DIR)).toBe('workflow/jaswanth/tickets/kar-13147')
  expect(workflowLabel('/elsewhere/x')).toBe('/elsewhere/x')
})

test('the pulse breathes from bright to dim and back over one cycle', () => {
  expect(pulseColor(0)).toBe(0xfbbf24)
  expect(pulseColor(PULSE_FRAMES / 2)).toBe(0x78350f)
  expect(pulseColor(PULSE_FRAMES)).toBe(pulseColor(0))
  // One cell: three little-endian u32 words.
  expect(atob(pulseCell('●', 3)).length).toBe(12)
})

test('times read in the host offset; the clock with its meridian', () => {
  expect(formatWhen('2026-10-07T06:22:18Z', 330)).toBe('Oct 7 11:52')
  expect(formatWhen('2026-10-07T06:22:18Z', 0)).toBe('Oct 7 06:22')
  expect(formatClock(Date.parse('2026-10-07T06:01:00Z'), 330)).toBe('11:31 AM')
  expect(formatClock(Date.parse('2026-10-07T06:31:00Z'), 330)).toBe('12:01 PM')
  expect(formatClock(Date.parse('2026-10-07T18:45:00Z'), 330)).toBe('12:15 AM')
  expect(formatClock(Date.parse('2026-10-07T13:15:00Z'), 0)).toBe('1:15 PM')
})

/** A ks workflow checkout, answered beneath the plugin. */
function checkout(on: On): void {
  mock.env(on, { HOME: '/home/u' })
  on('session.start', () => ({ cwd: ROOT }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const stdout = argv.startsWith('git rev-parse --show-toplevel')
      ? ROOT
      : argv.startsWith('git rev-parse --abbrev-ref HEAD')
        ? 'jaswanth/kar-13147-map-employee'
        : argv.startsWith('grep ')
          ? `${STATE}\n`
          : argv.startsWith('date ')
            ? '+0530'
            : e.argv[0] === 'node'
              ? JSON.stringify(ticketDoc)
              : ''
    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_$, e) => ({
    value: e.path === STATE
      ? 'ticket:\n  identifier: "KAR-13147"\n  url: "https://linear.app/x"\nphases:\n  - number: 1\n    name: "context-creation"\n    status: "COMPLETED"\n  - number: 9\n    name: "implementation-plan-creation"\n    status: "IN_PROGRESS"\n'
      : '',
  }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
}

const PANE = {
  component: 'Pane',
  requestId: 'ks-project',
  props: {
    title: 'KAR-13147',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane shows the ticket, phases, Slack, PRs and workspace', async ($, on) => {
  mock.clock(on)
  checkout(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ks', surface, ...PANE })
    expect(await ui.find({ type: 'Link', text: 'KAR-13147 ↗' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Map employee fails to assign expenses to the correct BC' })).toBeDefined()
    // The statusline's phase and status pill, from the same state.yaml (its Plan phase is IN_PROGRESS).
    expect(await ui.find({ type: 'Text', text: 'Plan phase' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'In Progress' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● IN PROGRESS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Urgent · 1 pt · Assignee Jaswanth · Due 2026-10-10' })).toBeDefined()
    // Calendar span only; the time spent comes from the time log (none here).
    expect(await ui.find({ type: 'Text', text: 'Oct 7 11:52 → Oct 7 12:16' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '#engineering ↗' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'GitHub ↗' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'review #engineering ↗' })).toBeDefined()
    // file:// links are links on the terminal; a remote surface draws them as text.
    const fileLink = surface === 'terminal' ? 'Link' : 'Text'
    expect(await ui.find({ type: fileLink, text: 'workflow/jaswanth/tickets/kar-13147 ↗' })).toBeDefined()
    expect(await ui.find({ key: 'copy-worktree' })).toBeDefined()
    expect(await ui.find({ key: 'copy-workflow' })).toBeDefined()
    // The phase being worked pulses on the terminal (a Raster cell); elsewhere a static dot.
    if (surface === 'terminal') expect(await ui.find({ type: 'Raster' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: '● ' })).toBeDefined()
    // Every link draws the same way: its text underlined, then the arrow.
    const ticket = await ui.find({ type: 'Link', text: 'KAR-13147 ↗' })
    expect(JSON.stringify(ticket)).toContain('underline')
    await ui.unmount()
  }
})
