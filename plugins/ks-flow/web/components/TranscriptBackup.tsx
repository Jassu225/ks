'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackupStatus, type UnitBackupStatus } from '@/lib/backupStatus';
import { SeeLogs, useStreams } from '@/components/StreamPanel';
import { backupKey, backupRunAliases, restoreKey } from '@/lib/backupStreams';

function absTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'no activity recorded';
}

/**
 * Per-unit backup + restore, on a board card and on the completed-work tables.
 *
 * Local transcripts are pruned at 30 days, so the interesting state is "the
 * bucket has sessions this machine no longer does" — that card gets an amber
 * Restore. Otherwise the control is a quiet cloud glyph that backs this one unit
 * up on demand, alongside the daemon's end-of-day sweep.
 *
 * "Back up" means transcript AND workflow: a session change uploads the changed
 * session files plus a refreshed workflow.tar.zst. Nothing changed in the window
 * means nothing to upload, so the tooltip says so rather than implying the click
 * always ships something.
 *
 * Restore never overwrites a local transcript (the CLI enforces that); it only
 * fills in what is missing, so clicking it while a session is live is safe.
 *
 * Done tickets leave the board for the completed tables, and they are the ones
 * old enough to have been pruned, so the Restore has to follow them there.
 * `restoreOnly` drops the backup button for a unit whose worktree is gone:
 * the sweep only backs up live worktrees, so it would have nothing to send.
 */
export function TranscriptBackup({ unitId, restoreOnly = false }: { unitId: string; restoreOnly?: boolean }) {
  const { status, refresh } = useBackupStatus(unitId);
  const { run, anyRunning } = useStreams();
  // A backup anywhere (this card's or the whole project's) holds the bucket; a
  // restore only this card's transcripts.
  const isBackingUp = anyRunning('backup:');
  const isRestoring = anyRunning(restoreKey(unitId));

  // Output goes to the shared bottom-right log panel — the same one Remove uses
  // — because a backup is not instant: a long transcript spends real time in
  // zstd and in the upload, and a button with no feedback reads as broken (it
  // did: a no-op click looked identical to a failure).
  const backup = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void run(backupKey(unitId), {
      title: `Backing up ${unitId}`,
      url: '/api/transcript-backup',
      body: { unit: unitId },
      successNote: '✓ backup complete',
      onSuccess: refresh,
      aliasesFrom: backupRunAliases,
    });
  };

  // Restore asks first: it writes into ~/.claude/projects, and the dialog is
  // where the workflow-folder opt-in lives.
  const [confirming, setConfirming] = useState(false);
  const askRestore = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setConfirming(true);
  };
  const restore = (choice: RestoreChoice): void => {
    setConfirming(false);
    void run(restoreKey(unitId), {
      title: `Restoring ${unitId}`,
      url: '/api/transcript-restore',
      body: { unit: unitId, workflow: choice.workflow },
      successNote: '✓ restore complete',
      onSuccess: refresh,
    });
  };

  const backedUpAt = status?.lastArchivedAt
    ? `Last backed up ${absTime(status.lastArchivedAt)}`
    : 'Never backed up';
  // Counts come from a per-file size+mtime comparison against the archive index
  // (see /api/transcript-backup GET), not from comparing how many files each
  // side has — equal counts can still be different files.
  const pending = status?.pendingCount ?? 0;
  // The files land in the worktree's encoded transcript dir either way, but
  // --resume lists a session only from a worktree that exists at that path.
  const worktreeGone = status && !status.worktreeExists
    ? ' The worktree is gone: recreate it at the same path before --resume will list them.'
    : '';

  return (
    <span className="inline-flex items-center gap-1">
      {!restoreOnly && (
        <>
          <button
            type="button"
            onClick={backup}
            disabled={isBackingUp}
            title={
              pending > 0
                ? `${pending} session file(s) on disk are new or have grown since their last ` +
                  `upload — back up transcript + workflow now. ${backedUpAt}.`
                : `Everything on disk is already in the bucket (${status?.cloudSessions ?? 0} ` +
                  `session file(s)). ${backedUpAt}.`
            }
            className={`rounded px-1.5 py-0.5 font-medium disabled:opacity-50 ${
              pending > 0
                ? 'bg-indigo-950 text-indigo-300 hover:bg-indigo-900'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
            }`}
          >
            ☁ backup{pending > 0 ? ` ${pending}` : ''}
          </button>
          <SeeLogs streamKey={backupKey(unitId)} />
        </>
      )}
      {/* Restore appears on its own the moment the bucket holds sessions this
          machine no longer has — that is the whole point of the backup, so it
          should never need hunting for. `legacyOnly` units have a pre-migration
          tarball and no per-file objects; restore can still read it, so offer it
          without a count. */}
      {status && (status.missingCount > 0 || (status.legacyOnly && status.localSessions === 0)) && (
        <button
          type="button"
          onClick={askRestore}
          disabled={isRestoring}
          title={
            status.missingCount > 0
              ? `${status.missingCount} backed-up session file(s) are no longer on disk ` +
                `(pruned at 30 days, or the worktree was removed) — restore them. ` +
                `Existing local transcripts are never overwritten.${worktreeGone}`
              : 'A pre-migration archive exists for this unit and nothing is on disk — ' +
                `restore unpacks it. Existing local transcripts are never overwritten.${worktreeGone}`
          }
          className="rounded bg-amber-950 px-1.5 py-0.5 font-medium text-amber-300 hover:bg-amber-900 disabled:opacity-50"
        >
          ⤓ restore{status.missingCount > 0 ? ` ${status.missingCount}` : ''}
        </button>
      )}
      {/* Outside the condition: a finished restore removes its own button, not its log. */}
      <SeeLogs streamKey={restoreKey(unitId)} />
      {confirming && status && (
        <RestoreDialog unitId={unitId} status={status} onCancel={() => setConfirming(false)} onConfirm={restore} />
      )}
    </span>
  );
}

interface RestoreChoice {
  workflow: boolean;
}

/**
 * Confirm a restore, with its workflow-folder opt-in. The time log has no
 * choice to offer: backups upload the union of the local and cloud logs, so the
 * cloud copy already holds every backed-up local event, and replacing the local
 * log could only drop the ones logged since — merging is always right. (The CLI
 * keeps --overwrite-time-log as an escape hatch.) Portalled to <body> so a card's
 * transform or overflow can't trap the overlay; every click stops propagation
 * because React still bubbles portal events up to the card underneath.
 */
function RestoreDialog({
  unitId,
  status,
  onCancel,
  onConfirm,
}: {
  unitId: string;
  status: UnitBackupStatus;
  onCancel: () => void;
  onConfirm: (choice: RestoreChoice) => void;
}) {
  const [workflow, setWorkflow] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const sessions =
    status.missingCount > 0
      ? `${status.missingCount} backed-up session file(s) missing from this machine`
      : 'the sessions in its pre-migration archive';
  const workflowWhere = status.worktreeExists
    ? 'into the worktree’s workflow/ folder'
    : 'into the main checkout’s workflow/ folder (the worktree is gone)';

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
        aria-labelledby="restore-dialog-title"
        className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 text-left text-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="restore-dialog-title" className="mb-2 text-sm font-semibold text-slate-100">
          Restore {unitId}?
        </h2>
        <p className="mb-1 text-xs text-slate-300">
          Brings back {sessions}. Transcripts already on disk are never overwritten.
        </p>
        <p className="mb-4 break-all font-mono text-[10px] text-slate-500">{status.transcriptDir}</p>
        {!status.worktreeExists && (
          <p className="mb-4 rounded bg-amber-950/50 px-2 py-1.5 text-[11px] text-amber-300">
            The worktree is gone: recreate it at the same path before --resume will list these sessions.
          </p>
        )}

        <label className="mb-4 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={workflow}
            onChange={(e) => setWorkflow(e.target.checked)}
            className="mt-0.5 accent-indigo-500"
          />
          <span>
            <span className="text-xs font-medium text-slate-200">Also restore the workflow folder</span>
            <span className="block text-[11px] text-slate-500">
              Unpacks state.yaml and resources/ {workflowWhere}. Fills in missing files only; files on disk are kept.
            </span>
          </span>
        </label>

        <p className="mb-5 text-[11px] text-slate-500">
          The time log is merged with the cloud copy; nothing is lost.
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
            onClick={() => onConfirm({ workflow })}
            className="rounded bg-amber-900 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-800"
          >
            Restore
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
