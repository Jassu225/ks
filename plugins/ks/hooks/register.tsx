import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, RenderSurface, TextProps } from 'claude-code'

import type { ProjectInfo, StatusFacts, WorkflowUnit } from '../types'
import { formatSpan, formatWhen, projectInfo, workflowLabel } from './project/info'
import { PULSE_FRAMES, PULSE_MS, pulseCell } from './project/pulse'
import { COLORS, limitViews } from './statusline/usage'
import { newlyCompleted, parseState, progress } from './statusline/workflow'
import type { Progress } from './statusline/workflow'

// The ks statusline is split in two. scripts/statusline draws the static half
// (session name, context, branch) in the statusline's own area; in claude-ks
// sessions (KS_MOD_STATUSLINE) it stops there. This module draws the
// interactive half in the prompt's hint line, one row under the engine's own
// line (kept, so its live pills stay): the checkout's ks workflow ticket and
// phase as pills, `≡ more`, and the rate-limit windows at the right.
//
// The project pane (/ks-project, or the statusline's `≡ more`) shows the
// whole state.yaml: the ticket, phases, Slack threads, PRs and the workspace.

const unitAtom = atom({ plugin: 'ks', key: 'workflowUnit' } as const, null)
const factsAtom = atom({ plugin: 'ks', key: 'statusFacts' } as const, null)
const infoAtom = atom({ plugin: 'ks', key: 'projectInfo' } as const, null)

const PANE = 'ks-project'
const PANE_COMMAND = 'ks-project'
const LABEL_COLUMNS = 16

/** Reads a YAML file to JSON with the `yaml` package ks scripts ship; argv: module, file. */
const YAML_TO_JSON =
  "const Y=require(process.argv[1]);process.stdout.write(JSON.stringify(Y.parse(require('fs').readFileSync(process.argv[2],'utf8'))))"

const POLL_MS = 5000

// Nerd Font glyphs: the rounded ends of a pill.
const CAP_LEFT = ''
const CAP_RIGHT = ''

const TICKET_BG = '#7c3aed'
const TICKET_HOVER_BG = '#8b5cf6'
const PILL_TEXT = '#ffffff'
const ACCENT = '#f59e0b'

/** A phase's glyph in the project pane, by state.yaml status. */
const NOT_STARTED_GLYPH = { glyph: '○', color: '#6b7280' }
const PHASE_GLYPHS: Record<string, { glyph: string; color: string }> = {
  COMPLETED: { glyph: '✓', color: '#16a34a' },
  IN_PROGRESS: { glyph: '●', color: ACCENT },
  REVISITING: { glyph: '↺', color: ACCENT },
  INVALIDATED: { glyph: '✕', color: '#ef4444' },
  SKIPPED: { glyph: '–', color: '#6b7280' },
  NOT_STARTED: NOT_STARTED_GLYPH,
}

/** A surface's element table, as `$.ui.resolve(e)` hands it to a render hook. */
type Els = Elements[RenderSurface]
type TextStyle = Pick<TextProps, 'color' | 'backgroundColor' | 'bold' | 'dimColor' | 'hover'>

/**
 * The one way a link is drawn, in the statusline and the pane alike: its text
 * underlined, then ↗ (not underlined), both in `style`.
 */
function linkTo(els: Els, key: string, href: string, text: string, style: TextStyle = {}) {
  const { Link, Text } = els
  return (
    <Link key={key} href={href}>
      <Text {...style} underline>
        {text}
      </Text>
      <Text {...style}>{' ↗'}</Text>
    </Link>
  )
}

/**
 * A rounded pill (Nerd Font caps). With `href` its body is a link (linkTo); with
 * `hoverBg` it brightens under the pointer, caps and all: an instant swap the
 * surface makes while the pointer is over the pill's keyed Box (no hook runs,
 * so nothing can be animated).
 */
function pill(els: Els, key: string, text: string, colors: { bg: string; fg: string; hoverBg?: string }, href?: string) {
  const { Box, Text } = els
  const { bg, fg, hoverBg } = colors
  const capHover = hoverBg ? { color: hoverBg } : undefined
  const style: TextStyle = { color: fg, backgroundColor: bg, bold: true, hover: hoverBg ? { backgroundColor: hoverBg } : undefined }
  return (
    <Box key={key} flexDirection="row" flexShrink={0}>
      <Text color={bg} hover={capHover}>
        {CAP_LEFT}
      </Text>
      {href ? linkTo(els, `${key}-link`, href, text, style) : <Text {...style}>{text}</Text>}
      <Text color={bg} hover={capHover}>
        {CAP_RIGHT}
      </Text>
    </Box>
  )
}

/** The ticket pill: links to Linear, brighter under the pointer. */
function ticketPill(els: Els, identifier: string | null, href: string) {
  return pill(els, 'ticket-pill', identifier ?? 'PROJECT', { bg: TICKET_BG, fg: PILL_TEXT, hoverBg: TICKET_HOVER_BG }, href)
}

/**
 * The current phase and its status pill, as the statusline and the project pane
 * both show them: the phase being worked, else the next one to start.
 */
function workflowStatus(unit: WorkflowUnit): { phase: string | null; pill: { text: string; bg: string; fg: string } } {
  const phases = progress(unit)
  const current = phases.active ?? phases.next
  // `Plan` alone can read as a noun; the suffix says it is the workflow's phase.
  return { phase: current ? `${current.label} phase` : null, pill: statusPill(phases) }
}

/** The status pill: where the workflow stands. */
function statusPill({ active, next, isSessionBoundary }: Progress): { text: string; bg: string; fg: string } {
  if (active?.status === 'REVISITING') return { text: '↺ REVISITING', bg: ACCENT, fg: '#1c1917' }
  if (active) return { text: '● IN PROGRESS', bg: ACCENT, fg: '#1c1917' }
  if (next) return { text: isSessionBoundary ? '◎ NEXT · NEW SESSION' : '◎ UP NEXT', bg: '#0e7490', fg: PILL_TEXT }
  return { text: '✓ DONE', bg: '#16a34a', fg: PILL_TEXT }
}

async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  const result = await $.process.run(argv).catch(() => null)
  return result && result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * The state.yaml that owns this checkout, the lookup scripts/workflow-unit does.
 * workflow/ is committed, so every checkout carries every unit's state.yaml;
 * the owner is the one whose worktree_dir points back at the git root. Older
 * ticket states predate worktree_dir, so fall back to the ticket id in the
 * branch name (workflow/<user>/tickets/<id>/state.yaml).
 */
async function findStateFile($: EngineInterface): Promise<string | null> {
  const root = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (!root || !(await $.fs.exists(`${root}/workflow`))) return null

  const home = (await $.env.get('HOME')) ?? ''
  const tilde = home && root.startsWith(home) ? `~${root.slice(home.length)}` : root
  const matches = await run($, [
    'grep', '-rlxF', '--include=state.yaml',
    '-e', `worktree_dir: "${tilde}"`, '-e', `worktree_dir: ${tilde}`,
    '-e', `worktree_dir: "${root}"`, '-e', `worktree_dir: ${root}`,
    `${root}/workflow`,
  ])
  const owned = matches?.split('\n')[0]
  if (owned) return owned

  const branch = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  const ticket = /[a-z]+-\d+/i.exec(branch ?? '')?.[0]?.toLowerCase()
  if (!ticket) return null
  const users = await $.fs.list(`${root}/workflow`).catch(() => [])
  for (const user of users) {
    if (user.kind !== 'dir') continue
    const path = `${root}/workflow/${user.name}/tickets/${ticket}/state.yaml`
    if (await $.fs.exists(path)) return path
  }
  return null
}

// The module re-runs on each reload, and session.start fires again with it.
let statePath: string | null = null
let mtimeMs = 0

async function loadUnit($: EngineInterface): Promise<void> {
  const stat = statePath ? await $.fs.stat(statePath).catch(() => null) : null
  if (!statePath || !stat) {
    statePath = null
    mtimeMs = 0
    await update($, unitAtom, () => null)
    await update($, infoAtom, () => null)
    return
  }
  if (stat.mtimeMs === mtimeMs) return
  mtimeMs = stat.mtimeMs

  const unit = parseState(await $.fs.read(statePath))
  if (!unit) return
  const before = await read($, unitAtom)
  await update($, unitAtom, () => unit)
  await loadInfo($)

  // Only a change seen while the session watched: the first read is not news.
  if (before && before.url === unit.url) {
    for (const done of newlyCompleted(before.phases, unit.phases)) {
      const { next, isSessionBoundary } = progress(unit)
      const then = next ? ` → next: ${next.label}${isSessionBoundary ? ' (new session)' : ''}` : ''
      $.ui.toast(`${unit.identifier ?? 'ks'}: phase ${done.number} completed${then}`)
    }
  }
}

/** The host's UTC offset in minutes (`date +%z`), read once: the hooks run with no time zone of their own. */
let utcOffsetMinutes: number | null = null

async function hostOffset($: EngineInterface): Promise<number> {
  if (utcOffsetMinutes !== null) return utcOffsetMinutes
  const z = (await run($, ['date', '+%z'])) ?? '+0000'
  const m = /^([+-])(\d\d)(\d\d)$/.exec(z)
  utcOffsetMinutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
  return utcOffsetMinutes
}

/** The whole state.yaml for the pane, parsed by node with the ks scripts' `yaml` package. */
async function loadInfo($: EngineInterface): Promise<void> {
  if (!statePath) {
    await update($, infoAtom, () => null)
    return
  }
  const workflowDir = statePath.slice(0, -'/state.yaml'.length)
  const json = await run($, ['node', '-e', YAML_TO_JSON, `${$.plugin.root}/scripts/node_modules/yaml`, statePath])
  let doc: unknown = null
  try {
    doc = json ? JSON.parse(json) : null
  } catch {
    doc = null
  }
  const info = projectInfo(doc, { workflowDir })
  const was = await read($, infoAtom)
  if (JSON.stringify(was) !== JSON.stringify(info)) await update($, infoAtom, () => info)
}

/** The pane's pulsing dot, while one is drawn: where to repaint it. */
let pulse: { requestId: string; key: string; glyph: string } | null = null
let pulseFrame = 0

/** Repaints the in-progress phase's dot with the next frame; a refused blit (pane closed) stops it. */
async function pulseTick($: EngineInterface): Promise<void> {
  if (!pulse) return
  pulseFrame = (pulseFrame + 1) % PULSE_FRAMES
  const { requestId, key, glyph } = pulse
  const result = await $.ui.blit({ requestId, key, cells: pulseCell(glyph, pulseFrame) }).catch(() => ({ deny: 'failed' }))
  if (result.deny !== undefined) pulse = null
}

async function openPane($: EngineInterface): Promise<void> {
  await loadInfo($)
  const info = await read($, infoAtom)
  await $.ui.open({ id: PANE, title: info?.identifier ?? 'Project' })
}

async function discoverUnit($: EngineInterface): Promise<void> {
  const found = await findStateFile($)
  if (found !== statePath) mtimeMs = 0
  statePath = found
  await loadUnit($)
}

async function loadFacts($: EngineInterface): Promise<void> {
  const usage = await $.session.usage().catch(() => null)
  const facts: StatusFacts = {
    limits: usage?.rateLimits ?? [],
    // The minute the figures were read: the reset countdowns move with it.
    minute: Math.floor((await $.clock.now()) / 60000),
  }
  // Write only a change: a write redraws the line.
  const was = await read($, factsAtom)
  if (JSON.stringify(was) !== JSON.stringify(facts)) await update($, factsAtom, () => facts)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE_COMMAND,
      description: "Show this checkout's ks workflow: ticket, phases, Slack threads, PRs and its folder",
    })
    await hostOffset($)
    await Promise.all([discoverUnit($), loadFacts($)])
    $.clock.every(POLL_MS, () => {
      void loadUnit($)
      void loadFacts($)
    })
    $.clock.every(PULSE_MS, () => {
      void pulseTick($)
    })
    return next(e)
  })

  // A checkout can change under the session (a branch switch, a worktree made
  // mid-session), and a turn moves the context figure: look again after each.
  on('turn.complete', async ($, e, next) => {
    await Promise.all([discoverUnit($), loadFacts($)])
    return next(e)
  })

  on('command.run', { command: PANE_COMMAND }, async $ => {
    await openPane($)
    const info = await read($, infoAtom)
    return { text: info ? `${info.identifier ?? info.name}: project pane opened.` : 'This checkout has no ks workflow (no state.yaml owns it).' }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const own = await next(e)
    const [unit, facts] = await Promise.all([read($, unitAtom), read($, factsAtom)])
    if (!unit && !facts) return own

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const now = (facts?.minute ?? 0) * 60000

    const workflow = unit
      ? (() => {
          const status = workflowStatus(unit)
          return [
            <Box key="ticket" flexShrink={0}>
              {ticketPill(els, unit.identifier, unit.url)}
            </Box>,
            status.phase && (
              <Box key="phase" flexShrink={0} marginLeft={1}>
                <Text color={ACCENT} bold>
                  {status.phase}
                </Text>
              </Box>
            ),
            <Box key="status" flexShrink={0} marginLeft={1}>
              {pill(els, 'status-pill', status.pill.text, status.pill)}
            </Box>,
          ]
        })()
      : []

    const limits = limitViews(facts?.limits ?? [], now)

    // One row under the engine's line: the interactive half of the statusline
    // (the workflow pills, `≡ more`, the rate limits). The static half (session,
    // context, branch) is scripts/statusline's, in the statusline's own area.
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="row">
          {workflow}
          {unit && (
            <Box key="details" flexShrink={0} marginLeft={1}>
              <Button key="open-project" label="≡ more" plain dimColor onPress={() => openPane($)} />
            </Box>
          )}
          <Box flexGrow={1} />
          {limits.map(l => (
            <Box key={l.kind} flexDirection="row" flexShrink={0} marginLeft={1}>
              <Text color={l.color}>{l.text}</Text>
              {l.reset && <Text color={COLORS.muted}>{l.reset}</Text>}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const info = await read($, infoAtom)
    pulse = null
    if (!info) {
      return (
        <Box flexDirection="column">
          <Text dimColor>This checkout has no ks workflow: no state.yaml under workflow/ owns it.</Text>
        </Box>
      )
    }
    const offset = utcOffsetMinutes ?? 0
    const when = (iso: string | null): string => (iso ? formatWhen(iso, offset) : '')

    const section = (title: string) => (
      <Box key={`h-${title}`} marginTop={1}>
        <Text bold color={TICKET_HOVER_BG}>
          {title}
        </Text>
      </Box>
    )

    // A labelled row: the label in a fixed dim column, the value wrapping beside it.
    const row = (key: string, label: string, value: RenderChildren) => (
      <Box key={key} flexDirection="row">
        <Box width={LABEL_COLUMNS} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" flexShrink={1}>
          {value}
        </Box>
      </Box>
    )

    const link = (key: string, label: string, href: string | null) => (
      <Box key={key} marginRight={2}>
        {href ? linkTo(els, `${key}-a`, href, label) : <Text>{label}</Text>}
      </Box>
    )

    const fileUrl = (path: string): string => `file://${encodeURI(path)}`

    // A dim `copy` beside a path: copies it on the surface pressed, and says so.
    const copyButton = (key: string, text: string, what: string) => (
      <Button
        key={key}
        label="copy"
        plain
        dimColor
        onPress={async press => {
          const { isCopied } = await $.ui.copy({ text, surface: press.surface })
          $.ui.toast(isCopied ? `${what} copied` : text)
        }}
      />
    )
    const meta = [
      info.priority,
      info.estimate !== null ? `${info.estimate} pt` : null,
      info.owner ? `${info.owner.role} ${info.owner.name}` : null,
      info.dueDate ? `Due ${info.dueDate}` : null,
    ].filter(Boolean)
    const unit = await read($, unitAtom)
    const status = unit ? workflowStatus(unit) : null

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box marginRight={1}>{ticketPill(els, info.identifier, info.url)}</Box>
          {/* The Linear issue's state, as ks-start-ticket recorded it. */}
          {info.status && pill(els, 'linear-status', info.status, { bg: '#334155', fg: '#e2e8f0' })}
        </Box>
        {/* The workflow's phase and status, as the statusline shows them, on a line of their own. */}
        {status && (
          <Box flexDirection="row" marginTop={1}>
            {status.phase && (
              <Box marginRight={1}>
                <Text color={ACCENT} bold>
                  {status.phase}
                </Text>
              </Box>
            )}
            {pill(els, 'status', status.pill.text, status.pill)}
          </Box>
        )}
        <Box marginTop={1}>
          <Text bold>{info.name}</Text>
        </Box>
        {meta.length > 0 && <Text dimColor>{meta.join(' · ')}</Text>}

        {section('PHASES')}
        {info.phases.length === 0 && <Text dimColor>No phases recorded yet.</Text>}
        {info.phases.map(p => {
          const glyph = PHASE_GLYPHS[p.status] ?? NOT_STARTED_GLYPH
          const span = p.startedAt && p.endedAt ? formatSpan(p.startedAt, p.endedAt) : null
          const times = p.startedAt ? `${when(p.startedAt)} → ${p.endedAt ? when(p.endedAt) : '…'}` : ''
          const extra = [span, p.iterations > 1 ? `${p.iterations} iterations` : null].filter(Boolean).join(', ')
          return row(
            `phase-${p.number}`,
            `${p.number}`.padStart(2) + ' ' + p.label,
            <Box flexDirection="row">
              {/* The phase being worked pulses: a Raster cell the pulse timer repaints (terminal only). */}
              {(p.status === 'IN_PROGRESS' || p.status === 'REVISITING') && e.surface === 'terminal' ? (
                (() => {
                  const { Raster } = $.ui.resolve(e)
                  const key = `pulse-${p.number}`
                  pulse = { requestId: e.requestId, key, glyph: glyph.glyph }
                  return (
                    <Box marginRight={1}>
                      <Raster key={key} columns={1} rows={1} cells={pulseCell(glyph.glyph, pulseFrame)} />
                    </Box>
                  )
                })()
              ) : (
                <Text color={glyph.color}>{`${glyph.glyph} `}</Text>
              )}
              <Text dimColor>{times ? `${times}${extra ? `  (${extra})` : ''}` : p.status.toLowerCase().replace(/_/g, ' ')}</Text>
            </Box>,
          )
        })}

        {section('SLACK')}
        {info.threads.length === 0 && <Text dimColor>No Slack threads recorded.</Text>}
        {info.threads.map((t, i) => row(`thread-${i}`, t.label, link(`thread-link-${i}`, t.channel ?? 'thread', t.url)))}

        {section('PULL REQUESTS')}
        {info.prs.length === 0 && <Text dimColor>No PRs yet.</Text>}
        {info.prs.map(pr =>
          row(
            `pr-${pr.number}`,
            `PR #${pr.number}`,
            <Box flexDirection="row" flexWrap="wrap">
              {link(`pr-link-${pr.number}`, 'GitHub', pr.url)}
              {pr.reviewThread && link(`pr-review-${pr.number}`, `review ${pr.reviewThread.channel ?? ''}`.trim(), pr.reviewThread.url)}
              {pr.createdAt && <Text dimColor>{when(pr.createdAt)}</Text>}
            </Box>,
          ),
        )}

        {section('LINEAR')}
        {row('linear-ticket', info.kind === 'ticket' ? 'Ticket' : 'Project', link('linear-link', info.identifier ?? info.name, info.url))}
        {info.parentProject && row('parent', 'Project', link('parent-link', info.parentProject.name, info.parentProject.url))}
        {info.relatedTickets.map(t => row(`related-${t.label}`, t.label, link(`related-link-${t.label}`, t.identifier, t.url)))}
        {info.initiatives.length > 0 && row('initiatives', 'Initiatives', <Text>{info.initiatives.join(', ')}</Text>)}
        {info.labels.length > 0 && row('labels', 'Labels', <Text>{info.labels.join(', ')}</Text>)}

        {section('WORKSPACE')}
        {info.worktree &&
          row(
            'worktree',
            'Worktree',
            <Box flexDirection="row" flexWrap="wrap">
              <Box marginRight={1} flexShrink={1}>
                <Text wrap="truncate-middle">{info.worktree}</Text>
              </Box>
              {copyButton('copy-worktree', info.worktree, 'Worktree path')}
            </Box>,
          )}
        {/* The unit's folder (state.yaml, resources/, handoffs/), shown from workflow/ on. */}
        {row(
          'workflow',
          'Workflow',
          <Box flexDirection="row" flexWrap="wrap">
            {link('workflow-link', workflowLabel(info.workflowDir), fileUrl(info.workflowDir))}
            {copyButton('copy-workflow', info.workflowDir, 'Workflow folder path')}
          </Box>,
        )}
      </Box>
    )
  })
}
