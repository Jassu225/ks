'use client';
// components/StreamPanel.tsx — the bottom-right streaming log panel, shared.
//
// It started life inside CompletedWorktrees for the Remove action. Backup and
// restore need exactly the same thing — "something is happening, here is the
// output" — so the panel, its state machine, and the NDJSON reader live here
// once. One provider means one panel can be on screen at a time, which is the
// point: two overlapping fixed panels in the same corner would be worse than no
// panel at all.
//
// Server routes speak the same NDJSON line protocol as /api/run-command:
//   { type: 'stdout' | 'stderr', data: string }   … appended live
//   { type: 'exit', code: number }                … terminal
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';

export type PanelState =
  /** `running` while output streams; resolves to ok/err on exit. */
  | { kind: 'running' | 'ok' | 'err'; title: string; output: string }
  /** A pre-flight message with an optional link to Settings. */
  | { kind: 'warn'; title: string; msg: string; settingsLink?: boolean }
  /** Caller-supplied body/actions — e.g. Remove's "kill these processes?" list. */
  | { kind: 'custom'; title: string; tone?: 'warn' | 'plain'; body: React.ReactNode; actions?: React.ReactNode };

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
}

interface StreamPanelApi {
  panel: PanelState | null;
  setPanel: (p: PanelState | null) => void;
  close: () => void;
  /** POST `url`, stream its NDJSON into the panel, resolve to the exit code. */
  runStream: (opts: RunStreamOpts) => Promise<number>;
  /** True while a runStream is in flight, so callers can disable buttons. */
  busy: boolean;
}

const Ctx = createContext<StreamPanelApi>({
  panel: null,
  setPanel: () => {},
  close: () => {},
  runStream: async () => -1,
  busy: false,
});

export function StreamPanelProvider({ children }: { children: React.ReactNode }) {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => setPanel(null), []);

  const runStream = useCallback(async (opts: RunStreamOpts): Promise<number> => {
    setBusy(true);
    let output = opts.initial ?? '';
    setPanel({ kind: 'running', title: opts.title, output });
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
        setPanel(mapped ?? { kind: 'err', title: opts.title, output: output + msg });
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
        setPanel({ kind: 'running', title: opts.title, output });
      }

      if (code === 0) {
        setPanel({
          kind: 'ok',
          title: opts.title,
          output: output + (opts.successNote ? `\n${opts.successNote}` : ''),
        });
        await opts.onSuccess?.();
      } else {
        setPanel({ kind: 'err', title: opts.title, output: output || `exit ${code}` });
        opts.onFailure?.(output, code);
      }
      return code;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setPanel({ kind: 'err', title: opts.title, output: output + `\n${msg}` });
      opts.onFailure?.(msg, -1);
      return -1;
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo(
    () => ({ panel, setPanel, close, runStream, busy }),
    [panel, close, runStream, busy],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <StreamPanelHost />
    </Ctx.Provider>
  );
}

export function useStreamPanel(): StreamPanelApi {
  return useContext(Ctx);
}

/** The panel itself. Rendered once by the provider. */
function StreamPanelHost() {
  const { panel, close } = useStreamPanel();
  const outputEnd = useRef<HTMLDivElement>(null);

  // keep the streaming output scrolled to the latest line
  useEffect(() => {
    if (panel && 'output' in panel) outputEnd.current?.scrollIntoView({ block: 'end' });
  }, [panel]);

  if (!panel) return null;

  const border =
    panel.kind === 'ok'
      ? 'border-emerald-800'
      : panel.kind === 'err'
        ? 'border-red-800'
        : panel.kind === 'warn' || (panel.kind === 'custom' && panel.tone !== 'plain')
          ? 'border-amber-800'
          : 'border-slate-700';

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex max-h-[60vh] w-[28rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-slate-950 shadow-xl ${border}`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs">
        <span className="flex items-center gap-2 font-medium text-slate-200">
          {panel.kind === 'running' && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          )}
          {panel.kind === 'ok' && <span className="text-emerald-400">✓</span>}
          {panel.kind === 'err' && <span className="text-red-400">✗</span>}
          {(panel.kind === 'warn' || panel.kind === 'custom') && (
            <span className="text-amber-400">⚠</span>
          )}
          {panel.title}
        </span>
        <button
          type="button"
          onClick={close}
          className="text-slate-500 hover:text-slate-300"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {panel.kind === 'warn' ? (
        <div className="px-3 py-3 text-xs text-amber-200">
          <p>{panel.msg}</p>
          {panel.settingsLink && (
            <Link
              href="/settings"
              className="mt-2 inline-block font-medium text-indigo-400 hover:text-indigo-300"
            >
              Open Settings →
            </Link>
          )}
        </div>
      ) : panel.kind === 'custom' ? (
        <div className="flex flex-col overflow-hidden">
          <div className="overflow-auto px-3 py-3 text-xs text-amber-200">{panel.body}</div>
          {panel.actions && (
            <div className="flex justify-end gap-2 border-t border-slate-800 px-3 py-2">
              {panel.actions}
            </div>
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
