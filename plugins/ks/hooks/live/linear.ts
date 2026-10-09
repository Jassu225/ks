import type { LinearStatus } from '../../types'

/** Linear's default colors per state type, for a state that carries none. */
const TYPE_COLORS: Record<string, string> = {
  triage: '#fc7840',
  backlog: '#bec2c8',
  unstarted: '#e2e2e2',
  started: '#f2c94c',
  completed: '#5e6ad2',
  canceled: '#95a2b3',
}

const FALLBACK_COLOR = '#94a3b8'

/** The issue's workflow state from `linear issue get <id> --json`; null when the output is not that. */
export function linearStatus(json: string | null, checkedMinute: number): LinearStatus | null {
  if (!json) return null
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  const state = (doc as { state?: { name?: unknown; type?: unknown; color?: unknown } } | null)?.state
  if (!state || typeof state.name !== 'string') return null
  const type = typeof state.type === 'string' ? state.type : ''
  const color = typeof state.color === 'string' && /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : (TYPE_COLORS[type] ?? FALLBACK_COLOR)
  return { name: state.name, type, color, checkedMinute }
}

/** Dark or light text, whichever reads on `hex` (a light Linear yellow needs dark text). */
export function textOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 0xff) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff)) / 255
  return luminance > 0.6 ? '#1c1917' : '#ffffff'
}
