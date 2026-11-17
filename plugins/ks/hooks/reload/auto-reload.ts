/**
 * The KS plugins reload themselves after an update, the way Plannotator does
 * (a port of Plannotator's apps/hook/hooks/mod/auto-reload.ts; the
 * differences are listed at the end of this header).
 *
 * The ks module is the one judge of "outdated" (installed.ts): what it loaded
 * (ks from `$.plugin.root`; ks-flow, which has no module, and ks-master in a
 * master session, read from disk when this module loaded) against what a
 * `/reload-plugins` would load now (each plugin's live folder, its
 * plugin.json version). When they differ, the offer names the target: every
 * tracked plugin's live version, `ks@1.0.7,ks-flow@0.3.0`. Then, from the
 * mod's clock (a `$.clock` timer, never a hook a turn waits on), this runs
 * `/reload-plugins ks` once, when:
 *  - no main-loop turn runs and no prompt is on its way in (inside
 *    `prompt.submit`, with no time limit, or entered as a new turn whose
 *    `turn.start` has not come yet): `busyReason`. Background agents and
 *    subagents do not hold it: `/reload-plugins` leaves them running;
 *  - the prompt box is empty (`$.prompt.read()`), so typed text is never in
 *    the way;
 *  - this session has not tried that target yet. The record is in `$.store`
 *    (it outlives the reload), per session id, with the last
 *    `AUTO_RELOAD_TRIED_KEEP` targets tried, so a reload that loads the same
 *    old code is never tried again: the session then shows the manual
 *    "run /reload-plugins" notice (the fallback, no retry). Nothing runs until
 *    the store has kept the pending record (written, then read back): a store
 *    that refuses or fails means no reload, never a loop. In memory, the
 *    module also keeps the targets it ran for, so even a store that loses the
 *    record later never lets it run twice for one target.
 * Every gate is checked again after the store calls, with no await between
 * that last check and the run; when one fails then, the record is put back.
 * A run the engine refused before it ran (the person stopped the session and
 * has not typed since, a host limit) is tried again only after the next
 * main-loop turn starts, at most `AUTO_RELOAD_MAX_REFUSALS` times per target.
 *
 * Never `--force`: `/reload-plugins` reads only `--force` and reloads every
 * plugin, so its prompt-cache warning ("Run /reload-plugins --force") comes
 * from a pending MCP/LSP change (ks-browser's, another plugin's), and forcing
 * would re-read the whole conversation uncached. That warning lands in the
 * output row, which is then shown, and the session falls back to the notice.
 *
 * In the chat: the engine's echo row, `/reload-plugins ks`, stays (Claude
 * Code skips a plugin's render hook on rows its own code raised). The output
 * row is hidden by `hidesReloadOutput` when it is a plain success of
 * `/reload-plugins ks`: the row carries no origin, so the same command typed
 * by the person is hidden too.
 *
 * After the reload the NEW module checks in (`checkIn`, at its first
 * session.start): it records that it loaded, with what it loaded
 * (`checked_in`, or `did_not_take` when it loaded another target than the one
 * asked for). A module still running `AUTO_RELOAD_CHECK_IN_MS` after its own
 * run resolved was not replaced: it records `did_not_take`. Every step is a
 * line in the debug log (`$.ui.log(…, { to: 'debug' })`).
 *
 * Giving up (`gaveUp`): a reload that did not take, refusals spent, a store
 * that fails, a target this session already tried. The mod then shows the
 * manual notice (a pill in the prompt hint row, one toast).
 *
 * Differences from Plannotator's original:
 *  - the offer comes from installed.ts, read by the ks module itself every
 *    minute, not from an Inbox poll; the target is a set of plugin versions;
 *  - `gaveUp` is new: Plannotator's Inbox shows its own manual notice;
 *  - busy is the main-loop turn and the prompt on its way in only (ks has no
 *    reviews or Inbox work in flight); no `noteTools` / `notePolled` (ks
 *    registers no tools and has no Inbox link);
 *  - the look runs on the mod's 5 s clock, not a 1 s tick:
 *    `AUTO_RELOAD_PROMPT_GAP_TICKS` is 6 (30 s, Plannotator's 30 ticks of 1 s).
 */

/** The built-in command run, without its slash. */
export const AUTO_RELOAD_COMMAND = 'reload-plugins'
/**
 * The argument the run passes, so the echo reads `/reload-plugins ks` and the
 * output row is told apart from a plain `/reload-plugins`. `/reload-plugins`
 * reads only `--force` / `force` and ignores other words: it reloads every
 * plugin, ks-flow and ks-master included.
 */
export const AUTO_RELOAD_ARGS = 'ks'
/** `$.store` key: session id to its last AutoReloadRecord. */
export const STORE_AUTO_RELOAD = 'autoReloads'
/** Sessions kept in the record, newest first. */
export const AUTO_RELOAD_KEEP = 50
/** Targets a session's record remembers as tried, newest last. */
export const AUTO_RELOAD_TRIED_KEEP = 10
/** How long the new module has to check in before the old one says the reload did not take. */
export const AUTO_RELOAD_CHECK_IN_MS = 30_000
/** The longest a queued run may wait for the session to go idle and still be the reason a module loaded. */
export const AUTO_RELOAD_QUEUE_MAX_MS = 30 * 60_000
/** Refused runs (the engine never ran the command) tried again per target, each after the next turn start. */
export const AUTO_RELOAD_MAX_REFUSALS = 3
/** After the store did not keep a record, how long before it is tried again. */
export const AUTO_RELOAD_STORE_RETRY_MS = 60_000
/**
 * Ticks a prompt that entered as a new turn (prompt.submit resolved with no
 * turn id) waits for its `turn.start` before it is let go (a slash command
 * that starts no turn): 30 s on the mod's 5 s clock. A prompt still inside
 * prompt.submit has no limit.
 */
export const AUTO_RELOAD_PROMPT_GAP_TICKS = 6

export type AutoReloadOutcome = 'pending' | 'checked_in' | 'did_not_take' | 'refused'

/** What this module loaded: `version` is the target string of its snapshot (installed.ts `targetOf`). */
export interface LoadedPluginInfo {
  /** `ks@1.0.6,ks-flow@0.2.2`; null when unreadable (then nothing runs). */
  version: string | null
  /** The ks plugin's folder (`$.plugin.root`); null when it could not be read. */
  root: string | null
  /** When the module took its snapshot, ms (`$.clock.now()`). */
  loaded_at: number
}

export interface AutoReloadRecord {
  /** The target the run was for: tried once per session. */
  version: string
  /** When the run was queued, ms. */
  at: number
  /** The module that ran it. */
  from: { version: string | null; loadedAt: number | null }
  outcome: AutoReloadOutcome
  /** Every target this session ran for (this one included), newest last, at most AUTO_RELOAD_TRIED_KEEP. */
  tried?: string[]
  /** Runs the engine refused before they ran (outcome `refused`). */
  refusals?: number
  /** The engine's words, for `refused`. */
  reason?: string
  /** Set by the new module at check-in. */
  checkedIn?: { at: number; version: string | null; loadedAt: number | null }
}

/** One target's runs in this module: how many, and whether the engine refused the last. */
export interface AutoReloadAttempt {
  runs: number
  refused: boolean
}

/**
 * The targets this module ran `/reload-plugins` for, in memory: a backstop
 * to the store, shared by every instance of the module (a `/clear` moves the
 * session id but not the module).
 */
const moduleAttempts = new Map<string, AutoReloadAttempt>()

export interface AutoReloadDeps {
  now(): Promise<number>
  sessionId: string
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  /** What this module loaded; null when the host cannot say (then nothing runs). */
  loaded(): Promise<LoadedPluginInfo | null>
  /** The prompt box's text now (`$.prompt.read()`); absent: the host has no box, nothing runs. */
  promptText?: () => Promise<string>
  /** Why not now, or null: a main-loop turn runs. Synchronous. */
  busyReason(): string | null
  /** `$.command.run({ command: 'reload-plugins', args: 'ks' })`; absent: nothing runs. */
  run?: () => Promise<unknown>
  /** Calls `fn` once after `ms` (a `$.clock` timer, which a reload cancels with this module). */
  after(ms: number, fn: () => void): void
  debug(text: string): void
  /** No reload for `target` from here on: the mod shows the manual notice. Called once per target per instance. */
  gaveUp?(target: string, why: string): void
  /** The in-memory runs per target; the module's own map unless a test gives one. */
  attempts?: Map<string, AutoReloadAttempt>
}

/** The records, read whole (anything else reads as none). */
export function readAutoReloads(value: unknown): Record<string, AutoReloadRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, AutoReloadRecord> = {}
  for (const [session, record] of Object.entries(value as Record<string, unknown>)) {
    if (!record || typeof record !== 'object') continue
    const r = record as Partial<AutoReloadRecord>
    if (typeof r.version !== 'string' || typeof r.at !== 'number' || typeof r.outcome !== 'string') continue
    out[session] = r as AutoReloadRecord
  }
  return out
}

/** The targets a record says this session already ran for. */
function triedOf(record: AutoReloadRecord | null): string[] {
  if (!record) return []
  const tried = Array.isArray(record.tried) ? record.tried.filter((v): v is string => typeof v === 'string') : []
  return tried.includes(record.version) ? tried : [...tried, record.version]
}

/**
 * Whether the store's record lets this session run for `target`: a target
 * never tried, or this one's refused run under the refusal limit.
 */
function storeAllows(previous: AutoReloadRecord | null, target: string): boolean {
  if (!previous) return true
  if (previous.version === target) return previous.outcome === 'refused' && (previous.refusals ?? 0) < AUTO_RELOAD_MAX_REFUSALS
  return !triedOf(previous).includes(target)
}

/**
 * Whether the CommandOutput row is a plain success of `/reload-plugins ks`,
 * the only row the mod hides: our argument, not an error, starting
 * `Reloaded:` and saying nothing went wrong. A warning (the prompt-cache one,
 * "installed but not applied", errors during load, a marketplace that could
 * not be reached) is shown, so the person sees why the plugins did not
 * reload. The row carries no origin: the same command typed by the person is
 * hidden the same way.
 */
export function hidesReloadOutput(props: { command?: unknown; args?: unknown; text?: unknown; isErrored?: unknown }): boolean {
  if (props.command !== AUTO_RELOAD_COMMAND || props.isErrored === true) return false
  if (typeof props.args !== 'string' || props.args.trim() !== AUTO_RELOAD_ARGS) return false
  if (typeof props.text !== 'string' || !props.text.trimStart().startsWith('Reloaded:')) return false
  return !/error|could not|not applied|--force|isn't available|failed/i.test(props.text)
}

/**
 * Did a `/reload-plugins` (typed or ours, any arguments) reload the plugins?
 * Its output starts `Reloaded:`; an error or failure says it did not. A
 * pending-MCP warning (`--force`) still reloaded the plugins.
 */
export function reloadRan(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trimStart().startsWith('Reloaded:')) return false
  return !/error|could not|failed/i.test(output)
}

export class AutoReload {
  /** The last offer: the target a reload loads, null for none; undefined before the first look. */
  private offer: string | null | undefined = undefined
  private running = false
  /** A refused run waits for the next main-loop turn start (input moved). */
  private heldForInput = false
  private disposed = false
  private readonly attempts: Map<string, AutoReloadAttempt>
  /** The store did not keep a record: no try before this time. */
  private storeRetryAt = 0
  /** Ticks seen, the clock of the prompt gap below. */
  private ticks = 0
  /** Prompts inside prompt.submit (the hooks beneath have not finished): busy with no time limit. */
  private promptsSubmitting = 0
  /** Prompts that entered as a new turn whose turn.start has not come, and the tick the last one entered. */
  private promptsAwaitingTurn = 0
  private promptAwaitingTick = 0
  /** The last reason a look stopped, logged once per change. */
  private lastHeld: string | null = null
  /** Targets `gaveUp` was called for. */
  private givenUp = new Set<string>()

  constructor(private readonly deps: AutoReloadDeps) {
    this.attempts = deps.attempts ?? moduleAttempts
  }

  /** Every look at the plugins: the target a reload loads, or null (up to date, or unknown). */
  setOffer(target: string | null): void {
    const next = target && target.trim() ? target.trim() : null
    if (next !== this.offer) this.deps.debug(`auto-reload: ${next ? `a reload loads ${next}` : 'no reload is needed'}`)
    this.offer = next
  }

  /** A main-loop turn started: a refused run may be tried again, and the prompts that entered have their turn. */
  onInputMoved(): void {
    this.heldForInput = false
    this.promptsAwaitingTurn = 0
  }

  /** A prompt reached our prompt.submit hook: busy until the hooks beneath have finished with it (notePromptLeft). */
  notePromptSubmitting(): void {
    this.promptsSubmitting += 1
  }

  /**
   * prompt.submit finished with a prompt notePromptSubmitting saw: `dropped`
   * (a hook beneath dropped it, or it threw), `into-turn` (it went into a turn
   * already running, which keeps the session busy), or `new-turn` (its
   * turn.start is still to come: busy until then, or AUTO_RELOAD_PROMPT_GAP_TICKS).
   */
  notePromptLeft(how: 'dropped' | 'into-turn' | 'new-turn'): void {
    if (this.promptsSubmitting > 0) this.promptsSubmitting -= 1
    if (how !== 'new-turn') return
    this.promptsAwaitingTurn += 1
    this.promptAwaitingTick = this.ticks
  }

  /** A look stopped for `reason`: one debug line per change of reason. */
  private held(reason: string): void {
    if (reason === this.lastHeld) return
    this.lastHeld = reason
    this.deps.debug(`auto-reload: not now (${reason})`)
  }

  /** No reload for `target` from here: the mod's manual notice, once per target. */
  private giveUp(target: string, why: string): void {
    if (this.givenUp.has(target)) return
    this.givenUp.add(target)
    this.deps.debug(`auto-reload: giving up on ${target} (${why}); the manual /reload-plugins notice shows`)
    this.deps.gaveUp?.(target, why)
  }

  dispose(): void {
    this.disposed = true
  }

  /** Every record, or null when the store could not be read. */
  private async readAll(): Promise<Record<string, AutoReloadRecord> | null> {
    try {
      return readAutoReloads(await this.deps.storeGet(STORE_AUTO_RELOAD))
    } catch {
      return null
    }
  }

  /**
   * Reads every record again (another session's process may have written its
   * own), changes this session's (`undefined`: leave it, nothing is written;
   * `null`: remove it) and writes. True when the store took a write.
   */
  private async update(change: (current: AutoReloadRecord | null) => AutoReloadRecord | null | undefined): Promise<boolean> {
    const all = await this.readAll()
    if (!all) return false
    const next = change(all[this.deps.sessionId] ?? null)
    if (next === undefined) return false
    if (next === null) delete all[this.deps.sessionId]
    else all[this.deps.sessionId] = next
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, AUTO_RELOAD_KEEP)
    try {
      await this.deps.storeSet(STORE_AUTO_RELOAD, Object.fromEntries(kept))
      return true
    } catch {
      return false
    }
  }

  /** This session's record, or null (none, or the store could not be read). */
  async record(): Promise<AutoReloadRecord | null> {
    return (await this.readAll())?.[this.deps.sessionId] ?? null
  }

  /** Why not now, from the synchronous gates alone: what is checked last, right before the run. */
  private busyNow(target: string): string | null {
    if (this.disposed) return 'the instance was disposed'
    if (this.offer !== target) return 'the offer changed'
    if (this.promptsSubmitting > 0) return 'a prompt is being submitted'
    if (this.promptsAwaitingTurn > 0) return 'a prompt waits for its turn to start'
    return this.deps.busyReason()
  }

  /** One look, from the mod's clock. Never throws; runs at most one reload at a time. */
  async tick(): Promise<void> {
    this.ticks += 1
    if (this.promptsAwaitingTurn > 0 && this.ticks - this.promptAwaitingTick > AUTO_RELOAD_PROMPT_GAP_TICKS) this.promptsAwaitingTurn = 0
    const target = this.offer
    if (this.running || this.disposed || this.heldForInput || !target || !this.deps.run || !this.deps.promptText) return
    this.running = true
    try {
      await this.consider(target)
    } catch (error) {
      this.deps.debug(`auto-reload: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async consider(target: string): Promise<void> {
    const early = this.busyNow(target)
    if (early !== null) return this.held(early)
    const attempt = this.attempts.get(target)
    // In memory first: this module ran for that target already (unless the engine refused it, within the limit).
    if (attempt && !(attempt.refused && attempt.runs < AUTO_RELOAD_MAX_REFUSALS)) return this.held(`this module already ran for ${target}`)
    const loaded = await this.deps.loaded()
    if (!loaded || loaded.version === null) return
    const start = await this.deps.now()
    if (start < this.storeRetryAt) return
    const all = await this.readAll()
    if (!all) {
      this.storeRetryAt = start + AUTO_RELOAD_STORE_RETRY_MS
      this.deps.debug('auto-reload: the store could not be read; nothing runs')
      this.giveUp(target, 'the store could not be read')
      return
    }
    const previous = all[this.deps.sessionId] ?? null
    if (!storeAllows(previous, target)) {
      this.held(`this session already tried ${target} (${previous?.outcome ?? 'no record'})`)
      // A pending record inside its check-in window is a reload still under way, not a failure.
      const underWay = previous?.outcome === 'pending' && start - previous.at <= 2 * AUTO_RELOAD_CHECK_IN_MS
      if (!underWay) this.giveUp(target, `already tried (${previous?.outcome ?? 'no record'})`)
      return
    }
    if ((await this.deps.promptText!()).trim() !== '') return this.held('text is in the prompt box')
    const beforeWrite = this.busyNow(target)
    if (beforeWrite !== null) return this.held(beforeWrite)

    // The pending record first, read back: nothing runs unless the store kept it.
    const at = await this.deps.now()
    const refusals = previous && previous.version === target ? (previous.refusals ?? 0) : 0
    const tried = [...triedOf(previous).filter((v) => v !== target), target].slice(-AUTO_RELOAD_TRIED_KEEP)
    const record: AutoReloadRecord = {
      version: target,
      at,
      from: { version: loaded.version, loadedAt: loaded.loaded_at },
      outcome: 'pending',
      tried,
      ...(refusals ? { refusals } : {}),
    }
    const wrote = await this.update(() => record)
    const kept = wrote ? await this.record() : null
    if (!kept || kept.at !== at || kept.version !== target || kept.outcome !== 'pending') {
      this.storeRetryAt = at + AUTO_RELOAD_STORE_RETRY_MS
      this.deps.debug(`auto-reload: the store did not keep the record (${wrote ? 'it read back otherwise' : 'the write failed'}); nothing runs`)
      this.giveUp(target, 'the store did not keep the record')
      return
    }

    // The last look, after the store calls: the box, then every synchronous
    // gate with no await between it and the run.
    const box = await this.deps.promptText!()
    const busy = box.trim() !== '' ? 'text is in the prompt box' : this.busyNow(target)
    if (busy !== null) {
      // Put the record back as it was: this run never happened.
      const putBack = await this.update((current) => (current && current.at === at && current.outcome === 'pending' ? previous : undefined))
      this.held(busy)
      if (!putBack) this.deps.debug(`auto-reload: the record could not be put back; ${target} stays pending and is not tried again in this session (the manual notice shows)`)
      return
    }
    this.lastHeld = null
    const runs = (attempt?.runs ?? 0) + 1
    this.attempts.set(target, { runs, refused: false })
    this.deps.debug(`auto-reload: running /${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS} (loaded ${loaded.version}, now ${target})`)
    try {
      // Queued by the engine and run once the session is idle. When the reload
      // replaces this module, nothing below runs: the new module checks in.
      await this.deps.run!()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.attempts.set(target, { runs, refused: true })
      this.heldForInput = true
      // Only over this run's own pending record: never over what a newer module wrote.
      await this.update((current) =>
        current && current.at === at && current.outcome === 'pending' ? { ...current, outcome: 'refused', refusals: refusals + 1, reason } : undefined,
      )
      const spent = refusals + 1 >= AUTO_RELOAD_MAX_REFUSALS || runs >= AUTO_RELOAD_MAX_REFUSALS
      this.deps.debug(`auto-reload: refused before it ran (${reason}); ${spent ? 'not tried again for this target' : 'tried again after the next turn starts'}`)
      if (spent) this.giveUp(target, `refused ${AUTO_RELOAD_MAX_REFUSALS} times (${reason})`)
      return
    }
    this.deps.debug('auto-reload: the command ran; waiting for the new module to check in')
    this.deps.after(AUTO_RELOAD_CHECK_IN_MS, () => {
      void this.notReplaced(record).catch(() => undefined)
    })
  }

  /**
   * Still here after the check-in window: the reload did not replace this
   * module. That is right when this module's own files did not change (a
   * release of ks's scripts only, or of ks-flow / ks-master): the engine
   * re-runs changed modules only, and the mod re-reads every plugin's version
   * after each `/reload-plugins` (register.tsx's `command.run` hook), so
   * `loaded()` already names the target. Then the reload took.
   */
  private async notReplaced(record: AutoReloadRecord): Promise<void> {
    if (this.disposed) return
    const loaded = await this.deps.loaded().catch(() => null)
    const version = loaded?.version?.trim() ?? null
    if (version === record.version) {
      const at = await this.deps.now()
      const took = await this.update((current) =>
        current && current.at === record.at && current.outcome === 'pending'
          ? { ...current, outcome: 'checked_in', checkedIn: { at, version, loadedAt: loaded?.loaded_at ?? null } }
          : undefined,
      )
      this.deps.debug(
        `auto-reload: this module stayed (only plugins without a module changed); they loaded ${version}${took ? '' : ' (the record could not be updated)'}`,
      )
      return
    }
    const wrote = await this.update((current) =>
      current && current.at === record.at && current.outcome === 'pending' ? { ...current, outcome: 'did_not_take' } : undefined,
    )
    if (!wrote) {
      // A new module checked in for this run: it is the session's now, and says nothing went wrong.
      const now = await this.record()
      if (now && now.at === record.at && now.outcome === 'checked_in') return
    }
    // Otherwise (written, or a store that lost the record) this module was not replaced.
    this.deps.debug(
      `auto-reload: this module was not replaced within ${AUTO_RELOAD_CHECK_IN_MS / 1000} s; not tried again for ${record.version}${wrote ? '' : ' (the record could not be updated)'}`,
    )
    this.giveUp(record.version, 'the reload did not replace the module')
  }

  /**
   * The module's first instance in this session: if this session's reload is
   * pending and this module loaded after it was queued (and checks in soon
   * after it loaded), this module is its result: `checked_in` when it loaded
   * the target asked for, `did_not_take` when it is still another. Returns
   * the record written, or null.
   */
  async checkIn(): Promise<AutoReloadRecord | null> {
    const record = await this.record()
    if (!record || record.outcome !== 'pending') return null
    const loaded = await this.deps.loaded()
    const now = await this.deps.now()
    const loadedAt = loaded?.loaded_at ?? null
    if (loadedAt === null || loadedAt < record.at || loadedAt - record.at > AUTO_RELOAD_QUEUE_MAX_MS || now - loadedAt > 2 * AUTO_RELOAD_CHECK_IN_MS) return null
    const version = loaded?.version ?? null
    const took = version !== null && version.trim() === record.version
    const checked: AutoReloadRecord = { ...record, outcome: took ? 'checked_in' : 'did_not_take', checkedIn: { at: now, version, loadedAt } }
    const wrote = await this.update((current) => (current && current.at === record.at && current.outcome === 'pending' ? checked : undefined))
    if (!wrote) return null
    this.deps.debug(
      `auto-reload: ${took ? 'checked in' : 'the reload did not take'} after /${AUTO_RELOAD_COMMAND}: loaded ${version ?? 'unknown'} (wanted ${record.version}) ${Math.round((now - record.at) / 100) / 10} s after the run was queued`,
    )
    return checked
  }
}
