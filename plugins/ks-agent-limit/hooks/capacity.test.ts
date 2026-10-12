import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import { denyText, liveOthers, localPeerCount, parseSessionFile, STALE_MS, usage } from './capacity'

test('localPeerCount counts this machine’s peer sessions, not cloud or Remote Control ones', () => {
  const listing = (rows: { type: string }[]) => ({ listing: '', sections: [{ kind: 'sessions', total: rows.length, rows }] })
  expect(localPeerCount(listing([{ type: 'interactive' }, { type: 'interactive' }, { type: 'cloud' }, { type: 'remote_control' }]))).toBe(2)
  // No peer section: no other session.
  expect(localPeerCount({ listing: '', sections: [] })).toBe(0)
  expect(localPeerCount({ listing: 'text only' })).toBe(null)
})

test('a session’s file counts while its heartbeat is fresh and it has not ended', () => {
  const now = 1_000_000
  const files = [
    { session: 'me', agents: 3, at: now },
    { session: 'a', agents: 2, at: now - 5_000 },
    { session: 'b', agents: 4, at: now - STALE_MS - 1 },
    { session: 'c', agents: 1, at: now, hasEnded: true },
  ]
  expect(liveOthers(files, 'me', now).map(f => f.session)).toEqual(['a'])
  expect(parseSessionFile('{"session":"a","agents":2,"at":5}')).toEqual({ session: 'a', agents: 2, at: 5, hasEnded: false })
  expect(parseSessionFile('nope')).toBe(null)
})

test('usage and the refusal read the same figures', () => {
  expect(usage(8, 3, 6)).toEqual({ limit: 8, sessions: 3, agents: 6, used: 9, free: 0 })
  expect(usage(8, 2, 1).free).toBe(5)
  const text = denyText(usage(8, 3, 5), 3)
  expect(text).toContain('8/8 in use')
  expect(text).toContain('sleep 180')
  expect(text).toContain('mcp__ks-agent-limit__capacity')
})

// The plugin end to end: a session with peers, its agents, and the shared folder.

const DIR = '/home/u/.claude/ks-agent-limit'

type World = {
  peers: number
  agents: AgentInfo[]
  files: Map<string, string>
  toasts: string[]
  status: (string | undefined)[]
  spawned: number
}

function machine(on: On, world: World): void {
  mock.env(on, { HOME: '/home/u' })
  on('session.start', () => ({ cwd: '/home/u/x' }))
  on('session.id', () => ({ value: 'me' }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ks-agent-limit__${e.name}` } }))
  on('agent.list', () => ({ value: world.agents }))
  on('fs.write', (_$, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: [...world.files.keys()].map(p => ({ name: p.slice(DIR.length + 1), kind: 'file' as const })),
  }))
  on('fs.read', (_$, e) => {
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({
    result: {
      listing: '',
      sections: [{ kind: 'sessions', total: world.peers, rows: Array.from({ length: world.peers }, () => ({ type: 'interactive' })) }],
    },
  }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    world.status.push(e.text)
    return { value: undefined }
  })
  // The engine starting the agent.
  on('agent.spawn', () => {
    world.spawned++
    return { model: 'claude-opus-5-5', agentId: `agent-${world.spawned}` }
  })
}

const agent = (id: string): AgentInfo => ({ id, description: 'x', type: 'Explore', status: 'running' })

test('spawns go through while slots are free; past the limit they are refused and the person is told', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = { peers: 2, agents: [], files: new Map(), toasts: [], status: [], spawned: 0 }
  // Another ks-agent-limit session with 3 agents.
  world.files.set(`${DIR}/other.json`, JSON.stringify({ session: 'other', agents: 3, at: clock.now() }))
  machine(on, world)
  await $.session.start({ cwd: '/home/u/x', surface: 'terminal', isInteractive: true })

  // This session's own file is up.
  expect(JSON.parse(world.files.get(`${DIR}/me.json`) ?? '{}')).toMatchObject({ session: 'me', agents: 0 })

  // 3 sessions + 3 agents = 6 of 8: two more fit.
  const slots = await $.tool.call({ tool: 'mcp__ks-agent-limit__capacity' })
  expect(slots.result).toMatchObject({ limit: 8, sessions: 3, agents: 3, used: 6, free: 2 })

  expect((await $.agent.spawn({ prompt: 'one' })).agentId).toBe('agent-1')
  world.agents.push(agent('agent-1'))
  expect((await $.agent.spawn({ prompt: 'two' })).agentId).toBe('agent-2')
  world.agents.push(agent('agent-2'))

  // 8 of 8: refused, nothing started, and the person sees why.
  const refused = await $.agent.spawn({ prompt: 'three' })
  expect(refused.deny).toContain('8/8 in use')
  expect(world.spawned).toBe(2)
  expect(world.toasts.at(-1)).toContain('Agent blocked: 8/8 slots in use')
  expect(world.status.at(-1)).toBe('⏳ agent slots full 8/8')
  // The refused spawn's reservation is released.
  expect(JSON.parse(world.files.get(`${DIR}/me.json`) ?? '{}')).toMatchObject({ agents: 2 })

  // The other session ends: its slot and agents free, the heartbeat takes the notice down.
  world.files.set(`${DIR}/other.json`, JSON.stringify({ session: 'other', agents: 0, at: clock.now(), hasEnded: true }))
  world.peers = 1
  await clock.advance(15_000)
  expect(world.status.at(-1)).toBe(undefined)
  expect((await $.agent.spawn({ prompt: 'three' })).agentId).toBe('agent-3')
})

test('a crashed session’s file stops counting once its heartbeat is stale', async ($, on) => {
  const clock = mock.clock(on)
  const world: World = { peers: 0, agents: [], files: new Map(), toasts: [], status: [], spawned: 0 }
  world.files.set(`${DIR}/dead.json`, JSON.stringify({ session: 'dead', agents: 6, at: clock.now() }))
  machine(on, world)
  await $.session.start({ cwd: '/home/u/x', surface: 'terminal', isInteractive: true })

  expect((await $.agent.spawn({ prompt: 'one' })).deny).toContain('8/8 in use')
  await clock.advance(STALE_MS + 1_000)
  expect((await $.agent.spawn({ prompt: 'one' })).agentId).toBe('agent-1')
})

test('the limit comes from the plugin’s options', { options: { max_parallel: 2 } }, async ($, on) => {
  mock.clock(on)
  const world: World = { peers: 0, agents: [], files: new Map(), toasts: [], status: [], spawned: 0 }
  machine(on, world)
  await $.session.start({ cwd: '/home/u/x', surface: 'terminal', isInteractive: true })
  expect((await $.agent.spawn({ prompt: 'one' })).agentId).toBe('agent-1')
  world.agents.push(agent('agent-1'))
  expect((await $.agent.spawn({ prompt: 'two' })).deny).toContain('2/2 in use')
})
