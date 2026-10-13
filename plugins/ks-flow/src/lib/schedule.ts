// One clock for every periodic job the daemon runs. A single timer ticks; each
// tick runs the jobs whose interval has passed since their last run. Same shape
// as the ks mod's hooks/live/schedule.ts (ks-flow is its own plugin, so it
// carries its own copy).
//
// Every interval is a multiple of the tick. Last-run times live in memory: after
// a restart every job runs on the first tick, which each job tolerates (its own
// gate — an mtime, a date, the store's run history — decides whether to act).

export type Job = {
  /** How long between runs, in ms; a multiple of the tick. */
  every: number;
  run: () => void | Promise<void>;
  /** The same job for one card only (a card's Refresh); absent when the job
   * has nothing card-specific to do (notifications, uploads, log rolls). */
  runFor?: (unitId: string) => void | Promise<void>;
};

export type Scheduler = {
  /** Runs every job that is due at `now` and not still running. */
  tick: (now: number) => void;
  /** Runs `name` at `now` regardless of its interval (something just changed). */
  kick: (name: string, now: number) => void;
  /** Runs every job's `runFor(unitId)`, in table order, one after another;
   * resolves with the jobs that threw. Independent of the jobs' clock runs. */
  runFor: (unitId: string) => Promise<{ name: string; error: string }[]>;
};

export function scheduler(
  jobs: Record<string, Job>,
  onError: (name: string, e: unknown) => void = () => {},
): Scheduler {
  const lastRun: Record<string, number> = {};
  const running = new Set<string>();

  const start = (name: string, now: number): void => {
    const job = jobs[name];
    // A slow run (a big workflow tree, a store round trip) must not be stacked on itself.
    if (!job || running.has(name)) return;
    running.add(name);
    lastRun[name] = now;
    void Promise.resolve()
      .then(() => job.run())
      .catch((e) => onError(name, e))
      .finally(() => running.delete(name));
  };

  return {
    tick(now) {
      for (const [name, job] of Object.entries(jobs)) {
        if (now - (lastRun[name] ?? -Infinity) >= job.every) start(name, now);
      }
    },
    kick(name, now) {
      start(name, now);
    },
    async runFor(unitId) {
      const failed: { name: string; error: string }[] = [];
      for (const [name, job] of Object.entries(jobs)) {
        if (!job.runFor) continue;
        try {
          await job.runFor(unitId);
        } catch (e) {
          failed.push({ name, error: (e as Error)?.message ?? String(e) });
          onError(`${name} (${unitId})`, e);
        }
      }
      return failed;
    },
  };
}
