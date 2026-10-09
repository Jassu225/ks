'use client';
// components/StreamPanel.tsx — live output of the board's long-running actions.
//
// An action (back up, restore, remove a worktree) is a STREAM, kept under a key
// the action chooses: `backup:all`, `backup:KAR-123`, `restore:KAR-123`,
// `remove:KAR-123`. Each stream has its own panel, stacked bottom-right, so two
// actions at once each keep their own output and outcome instead of
// overwriting one shared panel.
//
// The provider sits in the root layout (app/providers.tsx), so streams outlive
// a page change: start a backup on the board, open /backups, and it is still
// streaming. A panel's ✕ only hides it; the stream stays, and <SeeLogs> next to
// the action that started it brings it back. A stream lasts until it is
// dismissed, the same action runs again, or the page is reloaded.
//
// Server routes speak the same NDJSON line protocol as /api/run-command:
//   { type: 'stdout' | 'stderr', data: string }   … appended live
//   { type: 'exit', code: number }                … terminal
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

export type PanelState =
  /** `running` while output streams; resolves to ok/err on exit. */
  | { kind: 'running' | 'ok' | 'err'; title: string; output: string }
  /** A pre-flight message with an optional link to Settings. */
  | { kind: 'warn'; title: string; msg: string; settingsLink?: boolean }
  /** Caller-supplied body/actions — e.g. Remove's "kill these processes?" list. */
  | { kind: 'custom'; title: string; tone?: 'warn' | 'plain'; body: React.ReactNode; actions?: React.ReactNode };

export interface Stream {
  key: string;
  view: PanelState;
  /** Its panel is on screen; hidden streams are reached through <SeeLogs>. */
  isOpen: boolean;
  /** A request is in flight (or a caller marked a pre-flight step as running). */
  isRunning: boolean;
  /** More keys it answers to, learned from its output (e.g. `backup-run:<uid>`). */
  aliases: string[];
}

export interface RunStreamOpts {
  /** Shown in the panel header. */
  title: string;
  url: string;
  body?: unknown;
  /** Seed line so the panel is never empty while the request opens. */
  initial?: string;
  /** Appended to the output on a zero exit. */
  successNote?: string;
  /** Called after a zero exit — e.g. refresh board state. */
  onSuccess?: () => void | Promise<void>;
  /** Called after a non-zero exit. */
  onFailure?: (output: string, code: number) => void;
  /** A route that fails BEFORE streaming answers with plain JSON. Return a panel
   * state to render something better than the raw message — e.g. Remove's
   * "no command configured" warning with a link to Settings. */
  mapEarlyError?: (payload: unknown, status: number) => PanelState | undefined;
  /** Extra keys this stream answers to, read off its output as it arrives. */
  aliasesFrom?: (output: string) => string[];
}

interface StreamsApi {
  /** Every stream, oldest first. */
  streams: Stream[];
  /** The stream under `key`, or one that took `key` as an alias. */
  get: (key: string) => Stream | undefined;
  /** True while any stream whose key starts with `prefix` is running. */
  anyRunning: (prefix: string) => boolean;
  /** POST `url` and stream its NDJSON into `key`'s panel; resolves to the exit
   * code. Refused (-1) while `key` is already running. */
  run: (key: string, opts: RunStreamOpts) => Promise<number>;
  /** Show a non-streaming state under `key` (a warning, a confirmation, a
   * pre-flight step), opening its panel. */
  show: (key: string, view: PanelState, opts?: { isRunning?: boolean }) => void;
  open: (key: string) => void;
  /** Hide the panel; the stream stays, for <SeeLogs>. */
  hide: (key: string) => void;
  /** Forget the stream entirely. */
  dismiss: (key: string) => void;
}

const Ctx = createContext<StreamsApi>({
  streams: [],
  get: () => undefined,
  anyRunning: () => false,
  run: async () => -1,
  show: () => {},
  open: () => {},
  hide: () => {},
  dismiss: () => {},
});

export function StreamPanelProvider({ children }: { children: React.ReactNode }) {
  const [byKey, setByKey] = useState<Record<string, Stream>>({});
  // Keys with a request in flight. A pre-flight step shown as running (Remove's
  // "checking for live sessions…") is not one, so it hands over to its run.
  const inFlight = useRef(new Set<string>());

  const patch = useCallback((key: string, fn: (s: Stream | undefined) => Stream | null) => {
    setByKey((prev) => {
      const next = fn(prev[key]);
      const copy = { ...prev };
      delete copy[key]; // re-inserted last: a re-run moves to the bottom of the stack
      if (next) copy[key] = next;
      return copy;
    });
  }, []);

  const update = useCallback(
    (key: string, view: PanelState, isRunning: boolean, aliases?: string[]) =>
      setByKey((prev) => {
        const s = prev[key];
        if (!s) return prev; // dismissed mid-run: let it finish unseen
        return { ...prev, [key]: { ...s, view, isRunning, aliases: aliases ?? s.aliases } };
      }),
    [],
  );

  const show = useCallback(
    (key: string, view: PanelState, opts?: { isRunning?: boolean }) =>
      patch(key, (s) => ({ key, view, isOpen: true, isRunning: opts?.isRunning ?? false, aliases: s?.aliases ?? [] })),
    [patch],
  );

  const run = useCallback(
    async (key: string, opts: RunStreamOpts): Promise<number> => {
      if (inFlight.current.has(key)) return -1;
      inFlight.current.add(key);
      let output = opts.initial ?? '';
      let aliases: string[] = [];
      patch(key, () => ({ key, view: { kind: 'running', title: opts.title, output }, isOpen: true, isRunning: true, aliases }));
      try {
        const res = await fetch(opts.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts.body ?? {}),
        });

        // A route that failed before streaming (bad request, missing script)
        // answers with plain JSON, not NDJSON — surface its message rather than
        // rendering "[object Object]".
        if (!res.body || !(res.headers.get('content-type') ?? '').includes('ndjson')) {
          const text = await res.text();
          let msg = text;
          let parsed: unknown = undefined;
          try {
            parsed = JSON.parse(text);
            msg = (parsed as { error?: string })?.error ?? text;
          } catch {
            // not JSON — show it raw
          }
          const mapped = opts.mapEarlyError?.(parsed, res.status);
          update(key, mapped ?? { kind: 'err', title: opts.title, output: output + msg }, false);
          opts.onFailure?.(msg, res.status);
          return res.status;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let code = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line) as { type: string; data?: string; code?: number };
              if (ev.type === 'exit') code = ev.code ?? 0;
              else if (ev.data) output += ev.data;
            } catch {
              output += line + '\n'; // a non-JSON line still belongs in the log
            }
          }
          if (opts.aliasesFrom) aliases = [...new Set([...aliases, ...opts.aliasesFrom(output)])];
          update(key, { kind: 'running', title: opts.title, output }, true, aliases);
        }

        if (code === 0) {
          update(key, { kind: 'ok', title: opts.title, output: output + (opts.successNote ? `\n${opts.successNote}` : '') }, false);
          await opts.onSuccess?.();
        } else {
          update(key, { kind: 'err', title: opts.title, output: output || `exit ${code}` }, false);
          opts.onFailure?.(output, code);
        }
        return code;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        update(key, { kind: 'err', title: opts.title, output: output + `\n${msg}` }, false);
        opts.onFailure?.(msg, -1);
        return -1;
      } finally {
        inFlight.current.delete(key);
      }
    },
    [patch, update],
  );

  const setOpen = useCallback(
    (key: string, isOpen: boolean) =>
      setByKey((prev) => {
        const s = prev[key] ?? Object.values(prev).find((x) => x.aliases.includes(key));
        return s ? { ...prev, [s.key]: { ...s, isOpen } } : prev;
      }),
    [],
  );

  const value = useMemo<StreamsApi>(() => {
    const streams = Object.values(byKey);
    return {
      streams,
      get: (key) => byKey[key] ?? streams.find((s) => s.aliases.includes(key)),
      anyRunning: (prefix) => streams.some((s) => s.isRunning && s.key.startsWith(prefix)),
      run,
      show,
      open: (key) => setOpen(key, true),
      hide: (key) => setOpen(key, false),
      dismiss: (key) => patch(key, () => null),
    };
  }, [byKey, run, show, setOpen, patch]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <StreamPanels />
    </Ctx.Provider>
  );
}

export function useStreams(): StreamsApi {
  return useContext(Ctx);
}

/** One action's stream, for the component that starts it. */
export function useStream(key: string) {
  const api = useStreams();
  const stream = api.get(key);
  return {
    stream,
    isRunning: stream?.isRunning ?? false,
    run: (opts: RunStreamOpts) => api.run(key, opts),
    show: (view: PanelState, opts?: { isRunning?: boolean }) => api.show(key, view, opts),
    open: () => api.open(key),
    hide: () => api.hide(key),
    dismiss: () => api.dismiss(key),
  };
}

/**
 * "See logs", for beside the button that started a stream: shown once that
 * stream's panel is hidden, pulsing while it still runs. Nothing while the
 * panel is on screen, or when there is no stream.
 */
export function SeeLogs({ streamKey, className = '' }: { streamKey: string; className?: string }) {
  const { get, open } = useStreams();
  const stream = get(streamKey);
  if (!stream || stream.isOpen) return null;
  const tone =
    stream.view.kind === 'err'
      ? 'text-red-300 hover:text-red-200'
      : stream.view.kind === 'ok'
        ? 'text-emerald-300 hover:text-emerald-200'
        : 'text-indigo-300 hover:text-indigo-200';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // cards and table rows have their own click
        open(stream.key);
      }}
      title={stream.isRunning ? 'Still running — show its output' : 'Show the output of the last run'}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-slate-800 ${tone} ${className}`}
    >
      {stream.isRunning && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />}
      See logs
    </button>
  );
}

/** Every open stream's panel, stacked bottom-right, newest at the bottom. */
function StreamPanels() {
  const { streams } = useStreams();
  const open = streams.filter((s) => s.isOpen);
  if (open.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[calc(100vh-2rem)] w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto">
      {open.map((s) => (
        <StreamPanel key={s.key} stream={s} />
      ))}
    </div>
  );
}

function StreamPanel({ stream }: { stream: Stream }) {
  const { hide, dismiss } = useStreams();
  const panel = stream.view;
  const outputEnd = useRef<HTMLDivElement>(null);

  // keep the streaming output scrolled to the latest line
  const output = 'output' in panel ? panel.output : null;
  useEffect(() => {
    if (output !== null) outputEnd.current?.scrollIntoView({ block: 'end' });
  }, [output]);

  const border =
    panel.kind === 'ok'
      ? 'border-emerald-800'
      : panel.kind === 'err'
        ? 'border-red-800'
        : panel.kind === 'warn' || (panel.kind === 'custom' && panel.tone !== 'plain')
          ? 'border-amber-800'
          : 'border-slate-700';

  return (
    <div className={`flex max-h-[40vh] shrink-0 flex-col rounded-lg border bg-slate-950 shadow-xl ${border}`}>
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs">
        <span className="flex items-center gap-2 font-medium text-slate-200">
          {stream.isRunning && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />}
          {panel.kind === 'ok' && <span className="text-emerald-400">✓</span>}
          {panel.kind === 'err' && <span className="text-red-400">✗</span>}
          {(panel.kind === 'warn' || panel.kind === 'custom') && <span className="text-amber-400">⚠</span>}
          {panel.title}
        </span>
        <span className="flex items-center gap-2">
          {!stream.isRunning && (
            <button
              type="button"
              onClick={() => dismiss(stream.key)}
              className="text-[11px] text-slate-500 hover:text-slate-300"
              title="Forget this output (no See logs afterwards)"
            >
              clear
            </button>
          )}
          <button
            type="button"
            onClick={() => hide(stream.key)}
            className="text-slate-500 hover:text-slate-300"
            aria-label="Hide"
            title="Hide — See logs beside the action brings it back"
          >
            ✕
          </button>
        </span>
      </div>

      {panel.kind === 'warn' ? (
        <div className="px-3 py-3 text-xs text-amber-200">
          <p>{panel.msg}</p>
          {panel.settingsLink && (
            <Link href="/settings" className="mt-2 inline-block font-medium text-indigo-400 hover:text-indigo-300">
              Open Settings →
            </Link>
          )}
        </div>
      ) : panel.kind === 'custom' ? (
        <div className="flex flex-col overflow-hidden">
          <div className="overflow-auto px-3 py-3 text-xs text-amber-200">{panel.body}</div>
          {panel.actions && (
            <div className="flex justify-end gap-2 border-t border-slate-800 px-3 py-2">{panel.actions}</div>
          )}
        </div>
      ) : (
        <pre className="overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300">
          {panel.output || '…'}
          <div ref={outputEnd} />
        </pre>
      )}
    </div>
  );
}
