import type { EngineInterface, Register } from 'claude-code'

import {
  claimed,
  CONTEXT_RESTART_PERCENT,
  HEARTBEAT_MS,
  instructionsSection,
  owns,
  parseRequest,
  parseSession,
  pidFromSessionFile,
  plan,
  POLL_MS,
  requestOrder,
  type Heartbeat,
  type MasterRequest,
} from './master'

// The ks-master wake-up mod. Loaded only by `claude-ks-master`, which exports
// KS_MASTER_DIR (= <ks-flow data dir>/master) and KS_MASTER_HANDOFFS; without
// KS_MASTER_DIR every hook passes straight through.
//
// - session.json: fills in `pid` once loaded (and the session id after a
//   `/clear`), only while this process is the master the file names.
// - heartbeat.json every 30 s and on every main-loop turn start/end:
//   `{ sessionId, at, busy }`, busy = a main-loop turn is running.
// - requests/: checked every 15 s. When idle, the oldest request is moved to
//   done/ and its prompt submitted as a turn.
// - Context past 70 %: once, when idle, submits `/ks-master:restart context`.
// - The master instructions (../instructions.md) as hidden context on the
//   conversation's first prompt and on every wake-up (see the prompt.submit hook).
// - mod.log: one line per wake-up submitted, and whether it entered or was dropped.
//
// Idle vs busy: the engine has no "is a turn running" call, so the mod counts
// it from `turn.start` / `turn.complete` on the main loop (no `agentId`). A turn
// lasts from the prompt to the final answer (tool calls, permission prompts and
// all), so busy covers the whole of it. Background subagents do not count.
// `$.prompt.submit` itself never interrupts: a plugin's prompt "runs once the
// session is idle" (it queues behind a running turn); the mod still waits for
// idle so a request stays in requests/ — visible to the daemon's stuck check —
// until it is really taken.

let masterDir = ''
let handoffsDir = ''
let sessionsDir = ''
let instructions: string | null = null
/** Session ids whose first prompt already carried the instructions. */
const instructedSessions = new Set<string>()
let started = false

let sessionId = ''
/** This master's session.json startedAt (ms): restart requests older than it are dropped. */
let sessionStartedAt: number | null = null
let pid: number | null = null
let pidMisses = 0
let isOwner = false

let busy = false
let submitting = false
let contextPercent = 0
let contextNudged = false

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return $.fs.read(path).then(
    t => (typeof t === 'string' ? t : null),
    () => null,
  )
}

/** This Claude process's pid, from its `~/.claude/sessions/<pid>.json`; `$PPID` of a child after three misses. */
async function findPid($: EngineInterface): Promise<number | null> {
  if (pid !== null) return pid
  const entries = await $.fs.list(sessionsDir).catch(() => [])
  for (const f of entries) {
    if (f.kind !== 'file' || !/^\d+\.json$/.test(f.name)) continue
    const found = pidFromSessionFile(await readText($, `${sessionsDir}/${f.name}`), sessionId)
    if (found !== null) return (pid = found)
  }
  if (++pidMisses >= 3) {
    const r = await $.process.run(['/bin/sh', '-c', 'echo $PPID']).catch(() => null)
    const n = r && r.exitCode === 0 ? Number(r.stdout.trim()) : NaN
    if (Number.isInteger(n) && n > 1) return (pid = n)
  }
  return null
}

/** Re-reads session.json: is this process the master? Claims it (pid, session id) when it is. */
async function checkOwner($: EngineInterface): Promise<boolean> {
  sessionId = await $.session.id()
  await findPid($)
  const path = `${masterDir}/session.json`
  const session = parseSession(await readText($, path))
  const me = { sessionId, pid }
  isOwner = owns(session, me)
  const started = session ? Date.parse(session.startedAt) : NaN
  sessionStartedAt = Number.isFinite(started) ? started : null
  if (isOwner && session) {
    const next = claimed(session, me)
    if (next.pid !== session.pid || next.sessionId !== session.sessionId) {
      await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
    }
  }
  return isOwner
}

async function writeHeartbeat($: EngineInterface): Promise<void> {
  if (!isOwner) return
  const beat: Heartbeat = { sessionId, at: new Date(await $.clock.now()).toISOString(), busy: busy || submitting }
  await $.fs.write(`${masterDir}/heartbeat.json`, `${JSON.stringify(beat)}\n`)
}

async function beat($: EngineInterface): Promise<void> {
  await checkOwner($)
  await writeHeartbeat($)
}

/** `mv` into done/: the claim. A request someone else moved first fails here and is not submitted. */
async function moveToDone($: EngineInterface, name: string): Promise<boolean> {
  const r = await $.process
    .run(['/bin/sh', '-c', 'mkdir -p "$1" && mv "$2" "$1/"', 'mv-request', `${masterDir}/done`, `${masterDir}/requests/${name}`])
    .catch(() => null)
  return r !== null && r.exitCode === 0
}

/** One line in `<masterDir>/mod.log`: what the mod did with each wake-up. */
async function modLog($: EngineInterface, line: string): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  await $.process
    .run(['/bin/sh', '-c', 'printf "%s\\n" "$2" >> "$1"', 'mod-log', `${masterDir}/mod.log`, `${at} ${line}`])
    .catch(() => null)
}

/**
 * Run a wake-up as a turn and record what became of it. Every wake-up is a
 * slash command (`/ks-master:briefing schedule 06:00`), and Claude Code refuses
 * a plugin's `$.prompt.submit` whose text starts with `/` ("would run a command
 * as the user"; a host check), so a command goes through `$.command.run` (run
 * as if typed, once the session is idle) and only plain text through
 * `$.prompt.submit`. A `{ drop }` or a rejection is logged, and for a request
 * also written next to it in done/ (`<name>.dropped`): a lost wake-up is never
 * silent.
 */
async function submit($: EngineInterface, text: string, request?: string): Promise<void> {
  submitting = true
  try {
    await writeHeartbeat($)
    await modLog($, `submit ${request ?? '-'}: ${text}`)
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
    if (slash) {
      await $.command.run({ command: slash[1]!, args: slash[2] ?? '' })
      await modLog($, `ran ${request ?? '-'}: /${slash[1]}`)
      return
    }
    const result = await $.prompt.submit({ text })
    if (result && typeof result === 'object' && 'drop' in result && result.drop) {
      await modLog($, `dropped ${request ?? '-'}: ${result.drop}`)
      if (request) await $.fs.write(`${masterDir}/done/${request}.dropped`, `${result.drop}\n`).catch(() => undefined)
    } else {
      await modLog($, `entered ${request ?? '-'}`)
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await modLog($, `failed ${request ?? '-'}: ${why}`)
    if (request) await $.fs.write(`${masterDir}/done/${request}.dropped`, `${why}\n`).catch(() => undefined)
  } finally {
    submitting = false
  }
}

async function poll($: EngineInterface): Promise<void> {
  if (busy || submitting) return
  if (!(await checkOwner($))) return

  const dir = `${masterDir}/requests`
  const names = requestOrder((await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file').map(f => f.name))
  if (names.length > 0) {
    const pending: { name: string; request: MasterRequest | null }[] = []
    for (const name of names) pending.push({ name, request: parseRequest(await readText($, `${dir}/${name}`)) })
    const { take, drop } = plan(pending, sessionStartedAt)
    for (const name of drop) await moveToDone($, name)
    if (take && !busy && !submitting && (await moveToDone($, take.name))) {
      await submit($, take.request.prompt, take.name)
      return
    }
  }

  if (!contextNudged && contextPercent >= CONTEXT_RESTART_PERCENT && !busy && !submitting) {
    contextNudged = true
    await submit($, `/ks-master:restart context ${Math.round(contextPercent)}%`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const dir = await $.env.get('KS_MASTER_DIR')
    if (!dir) return next(e)
    masterDir = dir.replace(/\/+$/, '')
    handoffsDir = (await $.env.get('KS_MASTER_HANDOFFS')) ?? ''
    sessionsDir = `${(await $.env.get('HOME')) ?? ''}/.claude/sessions`
    const template = await readText($, `${$.plugin.root}/instructions.md`)
    instructions = template ? instructionsSection(template, { masterDir, handoffsDir, cwd: e.cwd }) : null

    const result = await next(e)
    await beat($).catch(() => undefined)
    if (!started) {
      started = true
      $.clock.every(HEARTBEAT_MS, () => {
        void beat($).catch(() => undefined)
      })
      $.clock.every(POLL_MS, () => {
        void poll($).catch(() => undefined)
      })
    }
    return result
  })

  // The master instructions ride along as hidden context (`prompt.submit`
  // `context`): on the conversation's first prompt, and on every wake-up this
  // plugin submits, so they hold after a compaction too. Not `prompt.compose`:
  // on Team/Enterprise accounts Claude Code's built-in guard
  // `cc-plugin-sec-default` sends that event (and classic.*, prompt.context,
  // skill.prompt, session.compact …) past user-tier plugins, and the
  // instructions never reached the system prompt. prompt.submit is not guarded.
  on('prompt.submit', async ($, e, next) => {
    if (!masterDir || !instructions) return next(e)
    const sid = await $.session.id()
    const wake = e.origin?.kind === 'plugin' && e.origin.name === 'ks-master'
    if (!wake && instructedSessions.has(sid)) return next(e)
    instructedSessions.add(sid)
    return next({ ...e, context: [...(e.context ?? []), instructions] })
  })

  on('turn.start', async ($, e, next) => {
    if (!masterDir || e.agentId !== undefined) return next(e)
    busy = true
    void writeHeartbeat($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!masterDir || e.agentId !== undefined) return next(e)
    busy = false
    const result = await next(e)
    const usage = await $.session.usage().catch(() => null)
    contextPercent = usage?.context.percent ?? contextPercent
    void writeHeartbeat($).catch(() => undefined)
    return result
  })
}
