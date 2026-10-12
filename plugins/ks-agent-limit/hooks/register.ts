import type { EngineInterface, Register } from 'claude-code'

import { blockedText, denyText, HEARTBEAT_MS, liveOthers, localPeerCount, parseSessionFile, usage, type Usage } from './capacity'

// Every open Claude session and every live agent on this machine holds a slot;
// a spawn that would pass the limit is refused, and the person is told. The
// model then waits and asks `mcp__ks-agent-limit__capacity` how many it may start.

const TOOL = 'capacity'

let limit = 8
let retryMinutes = 3
let dir = ''
let session = ''
/** Spawns let through and not yet started: published, so another session's gate counts them. */
let reserved = 0
/** A workflow's agents, which `$.agent.list()` never lists: counted from their spawn to their turn's end. */
const workflowAgents = new Set<string>()
let isBlocked = false

async function ownAgents($: EngineInterface): Promise<number> {
  return (await $.agent.list()).length + workflowAgents.size + reserved
}

/** Writes this session's file: the heartbeat the other sessions count it by. */
async function publish($: EngineInterface, hasEnded = false): Promise<void> {
  if (!session) return
  const file = { session, agents: hasEnded ? 0 : await ownAgents($), at: await $.clock.now(), hasEnded }
  await $.fs.write(`${dir}/${session}.json`, JSON.stringify(file))
}

/** Every slot in use on this machine now, this session's own included. */
async function measure($: EngineInterface): Promise<Usage> {
  const now = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const files = await Promise.all(
    entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
      .map(f => $.fs.read(`${dir}/${f.name}`).then(parseSessionFile, () => null)),
  )
  const others = liveOthers(files.flatMap(f => (f ? [f] : [])), session, now)
  // ListAgents also sees sessions started without this plugin; a session it
  // misses still counts through its file.
  const listed = await $.tool
    .call({ tool: 'ListAgents' })
    .then(r => (r.deny === undefined ? localPeerCount(r.result) : null), () => null)
  const peers = Math.max(listed ?? 0, others.length)
  const agents = (await ownAgents($)) + others.reduce((n, f) => n + f.agents, 0)
  return usage(limit, 1 + peers, agents)
}

function showBlocked($: EngineInterface, u: Usage): void {
  isBlocked = true
  $.ui.toast(blockedText(u, retryMinutes), { timeoutMs: 15_000 })
  $.ui.status(`⏳ agent slots full ${u.used}/${u.limit}`)
}

function clearBlocked($: EngineInterface): void {
  if (!isBlocked) return
  isBlocked = false
  $.ui.status(undefined)
}

/** The heartbeat: republish, and take the blocked notice down once a slot is free. */
async function beat($: EngineInterface): Promise<void> {
  await publish($)
  if (isBlocked && (await measure($)).free > 0) clearBlocked($)
}

export const register: Register = (on, options) => {
  limit = Number(options.max_parallel ?? 8)
  retryMinutes = Number(options.retry_minutes ?? 3)

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    dir = (await $.env.get('KS_AGENT_LIMIT_DIR')) ?? `${home}/.claude/ks-agent-limit`
    session = await $.session.id()
    await $.tool.register({
      name: TOOL,
      description:
        'Agent slots on this machine: every open Claude session and every live agent holds one, up to a limit. ' +
        'Call it before starting agents, and start at most `free` of them; a spawn past the limit is refused.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await publish($)
    $.clock.every(HEARTBEAT_MS, () => {
      void beat($).catch(() => undefined)
    })
    return next(e)
  })

  on('tool.call', { tool: /^mcp__ks-agent-limit__capacity$/ }, async $ => ({ result: await measure($) }))

  // The gate. Reserve first, then count: two sessions spawning at once each
  // see the other's reservation, so they cannot both take the last slot.
  // A gate that fails is skipped and the spawn goes on: it never strands work.
  on('agent.spawn', async ($, e, next) => {
    reserved++
    await publish($)
    const u = await measure($)
    if (u.used > u.limit) {
      reserved--
      await publish($)
      // Counted without the refused spawn: what is in use.
      const held = usage(limit, u.sessions, u.agents - 1)
      showBlocked($, held)
      return { deny: denyText(held, retryMinutes) }
    }
    try {
      const started = await next(e)
      if (started.agentId && e.workflow) workflowAgents.add(started.agentId)
      clearBlocked($)
      return started
    } finally {
      reserved--
      await publish($)
    }
  })

  // A workflow agent's slot frees when its turn ends; the listed agents leave
  // `$.agent.list()` on their own.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId && workflowAgents.delete(e.agentId)) await publish($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await publish($, true).catch(() => undefined)
    return next(e)
  })
}
