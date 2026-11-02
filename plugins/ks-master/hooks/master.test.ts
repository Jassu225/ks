import { expect, test } from 'claude-code/testing'

import { claimed, defaultPrompt, instructionsSection, owns, parseRequest, parseSession, pidFromSessionFile, plan, requestOrder } from './master'

const session = parseSession(
  JSON.stringify({ v: 1, sessionId: 's1', pid: null, tmuxPane: '%5', cwd: '/repo', startedAt: '2026-10-31T09:00:00.000Z', handoff: null }),
)

test('the master owns session.json by its session id, or by its pid after /clear', () => {
  expect(owns(session, { sessionId: 's1', pid: 42 })).toBe(true)
  expect(owns(session, { sessionId: 's2', pid: 42 })).toBe(false)
  const withPid = claimed(session!, { sessionId: 's1', pid: 42 })
  expect(withPid.pid).toBe(42)
  // After /clear the id moves on; the pid still matches, so the file follows it.
  expect(owns(withPid, { sessionId: 's9', pid: 42 })).toBe(true)
  expect(claimed(withPid, { sessionId: 's9', pid: 42 }).sessionId).toBe('s9')
  // An old master still shutting down never takes over the new one's file.
  expect(owns(withPid, { sessionId: 'old', pid: 7 })).toBe(false)
  expect(owns(null, { sessionId: 's1', pid: 42 })).toBe(false)
})

test('the pid comes from the Claude sessions file whose sessionId matches', () => {
  expect(pidFromSessionFile('{"pid":17986,"sessionId":"s1"}', 's1')).toBe(17986)
  expect(pidFromSessionFile('{"pid":17986,"sessionId":"other"}', 's1')).toBe(null)
  expect(pidFromSessionFile('not json', 's1')).toBe(null)
})

test('requests are taken oldest first; a second one of the same trigger and unreadable files are dropped', () => {
  const names = requestOrder(['2026-10-31T12:00:00.000Z-button.json', '2026-10-31T06:00:00.000Z-schedule.json', '.tmp', 'x.part'])
  expect(names).toEqual(['2026-10-31T06:00:00.000Z-schedule.json', '2026-10-31T12:00:00.000Z-button.json'])
  const req = (trigger: string, prompt = 'p') => parseRequest(JSON.stringify({ v: 1, id: trigger, trigger, slot: null, createdAt: '', prompt }))
  const out = plan([
    { name: 'a', request: req('schedule') },
    { name: 'b', request: null },
    { name: 'c', request: req('button') },
    { name: 'd', request: req('schedule') },
  ])
  expect(out.take?.name).toBe('a')
  expect(out.drop).toEqual(['b', 'd'])
  expect(plan([]).take).toBe(null)
})

test('a restart request made before this master started is dropped; other triggers still run', () => {
  const at = (trigger: string, createdAt: string) =>
    parseRequest(JSON.stringify({ v: 1, id: trigger, trigger, slot: null, createdAt, prompt: 'p' }))
  const started = Date.parse('2026-10-31T14:30:00.000Z')
  const out = plan(
    [
      { name: 'old-restart', request: at('restart', '2026-10-31T14:19:21.070Z') },
      { name: 'old-button', request: at('button', '2026-10-31T14:20:00.000Z') },
      { name: 'new-restart', request: at('restart', '2026-10-31T14:31:00.000Z') },
    ],
    started,
  )
  expect(out.drop).toEqual(['old-restart'])
  expect(out.take?.name).toBe('old-button')
  // Without a start time nothing is judged stale.
  expect(plan([{ name: 'r', request: at('restart', '2026-10-31T14:19:21.070Z') }]).take?.name).toBe('r')
})

test('a request without a prompt gets its trigger’s default', () => {
  expect(parseRequest('{"trigger":"schedule","slot":"06:00"}')?.prompt).toBe('/ks-master:briefing schedule 06:00')
  expect(parseRequest('{"trigger":"button","prompt":"  "}')?.prompt).toBe(defaultPrompt('button', null))
  expect(parseRequest('{"trigger":"restart","prompt":"Restart please"}')?.prompt).toBe('Restart please')
  expect(parseRequest('{"trigger":"nope"}')).toBe(null)
})

test('the instructions get this launch’s paths', () => {
  expect(instructionsSection('{{MASTER_DIR}} {{HANDOFFS_DIR}} {{CWD}} {{MASTER_DIR}}', { masterDir: '/d/master', handoffsDir: '/h', cwd: '/repo' })).toBe(
    '/d/master /h /repo /d/master',
  )
})
