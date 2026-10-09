// Run: node --import tsx --test lib/time-tracking.spec.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_IDLE_MS, formatDuration, intervals, parseLog, summarize, unionMs } from './time-tracking.js'
import type { TimeEvent } from './time-tracking.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 8, 6, 0)

/** An event `m` minutes after T0. */
const at = (m: number, event: string, extra: Partial<TimeEvent> = {}): TimeEvent => ({
  ts: T0 + m * MIN,
  event,
  session: 's1',
  phase: '9',
  ...extra,
})

test('a turn is agent time; a short gap after it is yours, a long one is away', () => {
  const s = summarize([
    at(0, 'SessionStart'),
    at(2, 'UserPromptSubmit'),
    at(5, 'PostToolUse'),
    at(12, 'Stop'),
    // 8 minutes reading: engaged.
    at(20, 'UserPromptSubmit'),
    at(30, 'Stop'),
    // 50 minutes away: not counted.
    at(80, 'UserPromptSubmit'),
    at(85, 'Stop'),
  ])
  assert.equal(s.agentMs, (10 + 10 + 5) * MIN)
  // + 2 (start → first prompt) + 8 (reading)
  assert.equal(s.engagedMs, (25 + 2 + 8) * MIN)
  assert.equal(s.sessions, 1)
})

test('a turn that never reached Stop counts only up to the idle cut-off', () => {
  const s = summarize([at(0, 'UserPromptSubmit'), at(3, 'PostToolUse'), at(120, 'UserPromptSubmit'), at(121, 'Stop')])
  assert.equal(s.agentMs, (3 + 10 + 1) * MIN)
})

test('a long tool call with no events in between is still agent time', () => {
  const s = summarize([at(0, 'UserPromptSubmit'), at(1, 'PostToolUse'), at(41, 'PostToolUse'), at(42, 'Stop')])
  assert.equal(s.agentMs, 42 * MIN)
})

test('a permission prompt is your time: counted while short, not while you are away', () => {
  const quick = summarize([at(0, 'UserPromptSubmit'), at(2, 'Notification', { kind: 'permission_prompt' }), at(4, 'PostToolUse'), at(5, 'Stop')])
  assert.equal(quick.agentMs, 3 * MIN)
  assert.equal(quick.engagedMs, 5 * MIN)
  const away = summarize([at(0, 'UserPromptSubmit'), at(2, 'Notification', { kind: 'permission_prompt' }), at(62, 'PostToolUse'), at(63, 'Stop')])
  assert.equal(away.engagedMs, 3 * MIN)
})

test('parallel subagents and a second session overlap once', () => {
  const s = summarize([
    at(0, 'UserPromptSubmit'),
    at(1, 'SubagentStart', { agent: 'a' }),
    at(1, 'SubagentStart', { agent: 'b' }),
    at(6, 'SubagentStop', { agent: 'a' }),
    at(8, 'SubagentStop', { agent: 'b' }),
    at(10, 'Stop'),
    // A background agent outlives the turn by 5 minutes.
    at(9, 'SubagentStart', { agent: 'c' }),
    at(15, 'SubagentStop', { agent: 'c' }),
    // Another session on the same ticket, overlapping the first.
    at(4, 'UserPromptSubmit', { session: 's2' }),
    at(14, 'Stop', { session: 's2' }),
  ])
  assert.equal(s.agentMs, 15 * MIN)
  assert.equal(s.sessions, 2)
})

test('time splits by phase and by local day', () => {
  const s = summarize([at(0, 'UserPromptSubmit'), at(10, 'Stop'), at(12, 'UserPromptSubmit', { phase: '10' }), at(20, 'Stop', { phase: '10' })])
  assert.deepEqual(s.byPhase['9'], { engagedMs: 12 * MIN, agentMs: 10 * MIN })
  assert.deepEqual(s.byPhase['10'], { engagedMs: 8 * MIN, agentMs: 8 * MIN })
  assert.equal(Object.values(s.byDay).reduce((n, d) => n + d.engagedMs, 0), s.engagedMs)
})

test('the idle cut-off is a parameter', () => {
  const events = [at(0, 'UserPromptSubmit'), at(5, 'Stop'), at(20, 'UserPromptSubmit'), at(25, 'Stop')]
  assert.equal(summarize(events).engagedMs, 10 * MIN)
  assert.equal(summarize(events, 30 * MIN).engagedMs, 25 * MIN)
  assert.equal(DEFAULT_IDLE_MS, 10 * MIN)
})

test('with now, a session still going counts up to it; a quiet or ended one does not', () => {
  const running = [at(0, 'UserPromptSubmit'), at(4, 'PostToolUse')]
  // Turn still running: 4m logged + 2m since the last tool call.
  assert.equal(summarize(running, DEFAULT_IDLE_MS, T0 + 6 * MIN).agentMs, 6 * MIN)
  // Without now, only what the events close.
  assert.equal(summarize(running).agentMs, 4 * MIN)
  // Heard from 30m ago: away or gone, adds nothing.
  assert.equal(summarize(running, DEFAULT_IDLE_MS, T0 + 34 * MIN).agentMs, 4 * MIN)
  // Reading after Stop: your time grows too.
  const reading = [at(0, 'UserPromptSubmit'), at(4, 'Stop')]
  assert.equal(summarize(reading, DEFAULT_IDLE_MS, T0 + 7 * MIN).engagedMs, 7 * MIN)
  const ended = [...reading, at(5, 'SessionEnd')]
  assert.equal(summarize(ended, DEFAULT_IDLE_MS, T0 + 7 * MIN).engagedMs, 5 * MIN)
})

test('parseLog skips a line cut short and sorts by time', () => {
  const log = [JSON.stringify(at(5, 'Stop')), '{"ts":12', JSON.stringify(at(1, 'UserPromptSubmit')), ''].join('\n')
  assert.deepEqual(parseLog(log).map(e => e.event), ['UserPromptSubmit', 'Stop'])
})

test('unionMs and formatDuration', () => {
  assert.equal(unionMs([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }]), 30)
  assert.equal(unionMs([]), 0)
  assert.equal(intervals([]).length, 0)
  assert.equal(formatDuration(192 * MIN), '3h 12m')
  assert.equal(formatDuration(47 * MIN), '47m')
})
