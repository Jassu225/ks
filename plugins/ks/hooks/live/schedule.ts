// One clock for every refresh the mod makes. A single timer ticks; each tick
// runs the jobs whose interval has passed since their last run. A job's
// interval is read every tick, so it follows state (the pane open, a deploy
// building) without timers being started or cancelled.

export type Job = {
  /** How long between runs at `now`, in ms; null pauses the job. */
  every: (now: number) => number | null
  run: () => Promise<void>
}

export type Scheduler = {
  /** Runs every job that is due at `now` and not still running. */
  tick: (now: number) => void
  /** Runs `name` at `now` regardless of its interval (the pane opened, a push). */
  kick: (name: string, now: number) => void
}

export function scheduler(jobs: Record<string, Job>): Scheduler {
  const lastRun: Record<string, number> = {}
  const running = new Set<string>()

  const start = (name: string, now: number): void => {
    const job = jobs[name]
    // A slow call (tsx, an MCP round trip) must not be stacked on itself.
    if (!job || running.has(name)) return
    running.add(name)
    lastRun[name] = now
    void job
      .run()
      .catch(() => undefined)
      .finally(() => running.delete(name))
  }

  return {
    tick(now) {
      for (const [name, job] of Object.entries(jobs)) {
        const ms = job.every(now)
        if (ms === null) continue
        if (now - (lastRun[name] ?? -Infinity) >= ms) start(name, now)
      }
    },
    kick(name, now) {
      start(name, now)
    },
  }
}
