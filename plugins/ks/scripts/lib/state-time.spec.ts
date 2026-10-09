// Run: node --import tsx --test lib/state-time.spec.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { phaseSpans, withTimeSpent } from './state-time.js'
import { summarize } from './time-tracking.js'
import type { TimeEvent } from './time-tracking.js'

const MIN = 60_000
const at = (m: number, event: string, phase: string): TimeEvent => ({ ts: m * MIN, event, session: 's1', phase })

const STATE = `# yaml-language-server: $schema=~/.claude/plugins/ks/scripts/ticket-state.schema.json

# Linear Ticket Information
ticket:
  identifier: "KAR-1"

# Phases tracking
phases:
  - number: 1
    name: "context-creation"
    status: "COMPLETED"
    started_at: "2026-10-07T06:22:18Z"
    ended_at: "2026-10-07T06:46:58Z"
  - number: 9
    name: "implementation-plan-creation"
    status: "IN_PROGRESS"
    iterations:
      - started_at: "2026-10-08T05:08:52.000Z"
        ended_at: null
`

const summary = summarize([at(0, 'UserPromptSubmit', '1'), at(10, 'Stop', '1'), at(12, 'UserPromptSubmit', '9'), at(20, 'Stop', '9')])

test('writes each phase and the total, leaving the rest of the file as it was', () => {
  const out = withTimeSpent(STATE, summary, '2026-10-09T06:00:00.000Z')
  assert.ok(out)
  assert.equal(
    out,
    STATE.replace('    ended_at: "2026-10-07T06:46:58Z"\n', '    ended_at: "2026-10-07T06:46:58Z"\n    engaged_minutes: 12\n').replace(
      '        ended_at: null\n',
      '        ended_at: null\n    engaged_minutes: 8\n',
    ) + 'time_spent:\n  engaged_minutes: 20\n  idle_cutoff_minutes: 10\n  updated_at: "2026-10-09T06:00:00.000Z"\n',
  )
})

test('figures already there: nothing to write, whatever the time', () => {
  const once = withTimeSpent(STATE, summary, '2026-10-09T06:00:00.000Z')
  assert.ok(once)
  assert.equal(withTimeSpent(once, summary, '2026-10-09T07:00:00.000Z'), null)
})

test('a changed figure rewrites it and stamps the time again', () => {
  const once = withTimeSpent(STATE, summary, '2026-10-09T06:00:00.000Z')
  assert.ok(once)
  const more = summarize([at(0, 'UserPromptSubmit', '1'), at(10, 'Stop', '1'), at(12, 'UserPromptSubmit', '9'), at(30, 'Stop', '9')])
  const twice = withTimeSpent(once, more, '2026-10-09T07:00:00.000Z')
  assert.ok(twice)
  assert.match(twice, /engaged_minutes: 18\n/)
  assert.match(twice, /time_spent:\n {2}engaged_minutes: 30\n {2}idle_cutoff_minutes: 10\n {2}updated_at: "2026-10-09T07:00:00.000Z"\n/)
})

test('phaseSpans: a run per iteration, else the phase itself; no start, no run', () => {
  const spans = phaseSpans(`phases:
  - number: 1
    status: "COMPLETED"
    started_at: "2026-10-09T16:59:40.000Z"
    ended_at: "2026-10-09T18:15:44.000Z"
  - number: 9
    status: "REVISITING"
    iterations:
      - started_at: "2026-10-09T19:02:09.000Z"
        ended_at: "2026-10-09T19:45:08.000Z"
      - started_at: "2026-10-10T08:00:00.000Z"
        ended_at: null
  - number: 10
    status: "NOT_STARTED"
`)
  assert.deepEqual(spans, [
    { phase: '1', start: Date.parse('2026-10-09T16:59:40.000Z'), end: Date.parse('2026-10-09T18:15:44.000Z') },
    { phase: '9', start: Date.parse('2026-10-09T19:02:09.000Z'), end: Date.parse('2026-10-09T19:45:08.000Z') },
    { phase: '9', start: Date.parse('2026-10-10T08:00:00.000Z'), end: null },
  ])
  assert.deepEqual(phaseSpans('ticket: {}'), [])
})
