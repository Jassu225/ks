// The rate-limit windows as the ks shell statusline (scripts/statusline) printed
// them, `5h: 10%/74%(4h 31m)`, colored by the usage each is on course for at reset.

/** The shell statusline's 256-color codes, as hex. */
export const COLORS = {
  muted: '#8a8a8a', // 245
  red: '#d75f5f', // 167
  yellow: '#ffd700', // 220
  green: '#87d787', // 114
} as const

const WINDOWS: Record<string, { label: string; seconds: number }> = {
  five_hour: { label: '5h', seconds: 5 * 3600 },
  seven_day: { label: '7d', seconds: 7 * 86400 },
}

export type LimitFigure = { kind: string; percentUsed: number; resetsAt?: string }

export type LimitView = {
  kind: string
  /** `5h: 10%`, then `/74%` when the window is far enough along to project. */
  text: string
  color: string
  /** `(4h 31m)`, drawn muted; empty without a reset time. */
  reset: string
}

/**
 * Rounds the way the shell statusline's `printf '%.0f'` does: halves go to the even
 * neighbour (10.5 → 10, 11.5 → 12), so both statuslines print the same percentage.
 */
export function roundHalfEven(n: number): number {
  const rounded = Math.round(n)
  return Math.abs(n % 1) === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded
}

export function formatReset(resetMs: number, nowMs: number): string {
  const diff = Math.floor((resetMs - nowMs) / 1000)
  if (diff <= 0) return 'now'
  const days = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  const mins = Math.floor((diff % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/**
 * Red when the window is on course to run out before it resets, yellow past 80%
 * of that, green otherwise; `budget` is how much of the window has elapsed, the
 * share that would be on pace. Early in a window (under 10% elapsed), or without
 * a reset time, it falls back to the raw percentage: red from 80, yellow from 50.
 */
export function usageColor(
  percentUsed: number,
  resetMs: number | null,
  windowSeconds: number,
  nowMs: number,
): { color: string; budget: number | null } {
  const used = roundHalfEven(percentUsed)
  const raw = { color: used >= 80 ? COLORS.red : used >= 50 ? COLORS.yellow : COLORS.green, budget: null }
  if (resetMs === null || !Number.isFinite(resetMs)) return raw

  const elapsed = windowSeconds - Math.floor((resetMs - nowMs) / 1000)
  if (elapsed <= 0) return raw
  const budget = Math.floor((elapsed * 100) / windowSeconds)
  if (budget < 10) return raw

  const projected = Math.floor((used * 100) / budget)
  const color = projected >= 100 ? COLORS.red : projected >= 80 ? COLORS.yellow : COLORS.green
  return { color, budget }
}

/** The windows the statusline shows (five-hour, seven-day), in that order. */
export function limitViews(limits: LimitFigure[], nowMs: number): LimitView[] {
  return Object.entries(WINDOWS).flatMap(([kind, window]) => {
    const limit = limits.find(l => l.kind === kind)
    if (!limit) return []
    // An unparsable reset time counts as none: raw-percent color and no countdown,
    // never `/NaN%` or `(NaNm)`.
    const parsedReset = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
    const resetMs = Number.isFinite(parsedReset) ? parsedReset : null
    const { color, budget } = usageColor(limit.percentUsed, resetMs, window.seconds, nowMs)
    const used = roundHalfEven(limit.percentUsed)
    return [
      {
        kind,
        text: `${window.label}: ${used}%${budget === null ? '' : `/${budget}%`}`,
        color,
        reset: resetMs === null ? '' : `(${formatReset(resetMs, nowMs)})`,
      },
    ]
  })
}
