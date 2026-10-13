'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SeeLogs, useStreams } from '@/components/StreamPanel';
import type { WorkUnitDoc } from '@/lib/types';

interface BusyProc {
  pid: number;
  command: string;
  isClaude: boolean;
}

// Each Remove is a stream (components/StreamPanel.tsx) under `remove:<unitId>`,
// with its own bottom-right panel. Remove's two special cases are states of that
// stream: `warn` for "no command configured", and `custom` for the "a live
// process is still in this worktree" confirm prompt. Hidden, it comes back
// through See logs beside the button.

/**
 * Remove a unit's git worktree: confirm first, then run the user's configured
 * removal command (Settings) via /api/run-command, streaming its output into the
 * bottom-right panel. Used by the completed-worktrees table and by board cards,
 * where the ticket is still open — the dialog says so, since the usual removal
 * command (`remove_worktree -D`) also deletes the branch.
 */
export function RemoveWorktree({
  unit,
  completed,
  onRemoved,
}: {
  unit: WorkUnitDoc;
  /** Linear says the work is done; otherwise the dialog warns it is still open. */
  completed: boolean;
  onRemoved?: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removeCommand, setRemoveCommand] = useState<string | null>(null);
  const [backupFirst, setBackupFirst] = useState(false);
  const { get, show, run, dismiss } = useStreams();
  const key = `remove:${unit.unitId}`;
  const stream = get(key);
  /** Running, or waiting on the kill-sessions confirmation. */
  const busy = Boolean(stream && (stream.isRunning || stream.view.kind === 'custom'));

  // Fetched when the dialog opens, not per card: the board renders dozens.
  useEffect(() => {
    if (!confirming || removeCommand !== null) return;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { removeCommand?: string; gcsArchive?: { enabled?: boolean } }) => {
        setRemoveCommand(s.removeCommand ?? '');
        setBackupFirst(s.gcsArchive?.enabled === true);
      })
      .catch(() => setRemoveCommand(''));
  }, [confirming, removeCommand]);

  // Stream the remove command, optionally killing live sessions in the worktree
  // first (only after the user confirmed). Updates the panel live + on exit.
  const doRemove = async (kill: boolean): Promise<void> => {
    if (!unit.worktreeDir) return;
    if (kill) {
      show(key, { kind: 'running', title: unit.identifier, output: 'killing sessions in worktree…\n' }, { isRunning: true });
      const kRes = await fetch('/api/worktree-kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: unit.worktreeDir }),
      });
      const k = await kRes.json().catch(() => ({ stillAlive: [] }));
      if (Array.isArray(k.stillAlive) && k.stillAlive.length) {
        show(key, {
          kind: 'err',
          title: unit.identifier,
          output: `could not kill pid(s) ${k.stillAlive.join(', ')} — remove aborted`,
        });
        return;
      }
    }

    await run(key, {
      title: unit.identifier,
      url: '/api/run-command',
      body: { path: unit.worktreeDir, identifier: unit.identifier, title: unit.title },
      successNote: '✓ removed',
      onSuccess: async () => {
        await onRemoved?.();
      },
      // The route answers with JSON (not NDJSON) when no removal command is
      // configured; that deserves a link to Settings, not a raw error line.
      mapEarlyError: (payload: unknown) =>
        (payload as { needsConfig?: boolean; error?: string })?.needsConfig
          ? {
              kind: 'warn',
              title: 'No remove command',
              msg: (payload as { error?: string }).error ?? 'Set a removal command in Settings.',
              settingsLink: true,
            }
          : undefined,
    });
  };

  const onConfirm = async (): Promise<void> => {
    setConfirming(false);
    if (!unit.worktreeDir || busy) return;
    if (removeCommand !== null && !removeCommand.trim()) {
      show(key, {
        kind: 'warn',
        title: 'No remove command',
        msg: 'Set a removal command in Settings before removing a worktree.',
        settingsLink: true,
      });
      return;
    }
    show(key, { kind: 'running', title: unit.identifier, output: 'checking for live sessions…' }, { isRunning: true });
    try {
      const busyRes = await fetch('/api/worktree-busy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: unit.worktreeDir }),
      });
      const live = await busyRes.json().catch(() => ({ busy: false, processes: [] }));
      if (busyRes.ok && live.busy) {
        // Don't remove blindly — ask the user to approve killing the sessions.
        const procs: BusyProc[] = live.processes ?? [];
        const claude = procs.some((p) => p.isClaude);
        show(key, {
          kind: 'custom',
          title: unit.identifier,
          body: (
            <>
              <p className="mb-2">
                {claude
                  ? 'A Claude Code session is still live in this worktree. Killing it will lose its current turn.'
                  : 'A process is still using this worktree.'}
              </p>
              <ul className="space-y-1 font-mono text-[11px] text-slate-400">
                {procs.map((p) => (
                  <li key={p.pid} className="truncate" title={p.command}>
                    <span className={p.isClaude ? 'text-indigo-300' : 'text-slate-500'}>
                      {p.isClaude ? 'claude' : 'proc'}
                    </span>{' '}
                    <span className="text-slate-600">pid {p.pid}</span> · {p.command}
                  </li>
                ))}
              </ul>
            </>
          ),
          actions: (
            <>
              <button
                type="button"
                onClick={() => dismiss(key)}
                className="rounded bg-slate-800 px-3 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doRemove(true)}
                className="rounded bg-red-700 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-600"
              >
                Kill sessions &amp; remove
              </button>
            </>
          ),
        });
        return;
      }
    } catch {
      show(key, {
        kind: 'err',
        title: unit.identifier,
        output: 'Could not check for live sessions — is the board server still running?',
      });
      return;
    }
    // worktree is clear — remove without killing.
    await doRemove(false);
  };

  if (!unit.worktreeDir) return null;

  return (
    <span className="inline-flex items-center gap-1">
      <SeeLogs streamKey={key} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!busy) setConfirming(true);
        }}
        disabled={busy}
        title="Remove this git worktree"
        className="rounded bg-red-950/60 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-900/70 disabled:opacity-50"
      >
        {stream?.isRunning ? 'removing…' : 'Remove'}
      </button>
      {confirming && (
        <RemoveDialog
          unit={unit}
          completed={completed}
          removeCommand={removeCommand}
          backupFirst={backupFirst}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void onConfirm()}
        />
      )}
    </span>
  );
}

/**
 * Confirm a worktree removal. Portalled to <body> so a card's transform or
 * overflow can't trap the overlay; every click stops propagation because React
 * still bubbles portal events up to the card underneath.
 */
function RemoveDialog({
  unit,
  completed,
  removeCommand,
  backupFirst,
  onCancel,
  onConfirm,
}: {
  unit: WorkUnitDoc;
  completed: boolean;
  removeCommand: string | null;
  /** GCS archiving is on: /api/run-command backs the worktree up before running the command. */
  backupFirst: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const command = removeCommand?.trim()
    ? removeCommand
        .replaceAll('{{path}}', unit.worktreeDir ?? '')
        .replaceAll('{{identifier}}', unit.identifier)
        .replaceAll('{{title}}', unit.title)
    : null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-dialog-title"
        className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 text-left text-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="remove-dialog-title" className="mb-2 text-sm font-semibold text-slate-100">
          Remove the {unit.identifier} worktree?
        </h2>
        <p className="mb-1 text-xs text-slate-300">{unit.title}</p>
        <p className="mb-4 break-all font-mono text-[10px] text-slate-500">{unit.worktreeDir}</p>

        {!completed && (
          <p className="mb-4 rounded bg-red-950/60 px-2 py-1.5 text-[11px] text-red-300">
            This ticket is not finished
            {unit.linearStatus ? ` (Linear: ${unit.linearStatus})` : ''}. Push any commits you want to keep first:
            if your removal command deletes the branch, unpushed work on it is gone.
          </p>
        )}

        {removeCommand !== null && (
          <p className="mb-3 text-[11px] text-slate-400">
            {backupFirst
              ? '1. Backs up its sessions, workflow folder and time log to the cloud. If that fails, nothing is removed.'
              : 'Cloud backup is off (Settings): its sessions are not backed up before removal.'}
          </p>
        )}
        <p className="mb-1 text-[11px] text-slate-500">
          {backupFirst ? '2. Then runs your removal command:' : 'Runs your removal command:'}
        </p>
        <p className="mb-5 break-all rounded bg-slate-950 px-2 py-1.5 font-mono text-[10px] text-slate-400">
          {removeCommand === null ? 'loading…' : command ?? 'none set — configure one in Settings'}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700"
          >
            Remove worktree
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
