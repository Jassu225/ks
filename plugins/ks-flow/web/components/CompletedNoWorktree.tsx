'use client';
import type { WorkUnitDoc } from '@/lib/types';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Finished work whose git worktree is already gone (removed/cleaned up) — the
 * archive tail of the board. Read-only: there's no worktree left to act on.
 * Hidden by default; the board's "show completed" checkbox reveals it.
 */
export function CompletedNoWorktree({ units }: { units: WorkUnitDoc[] }) {
  return (
    <section className="mt-8 border-t border-slate-800 pt-5">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Completed · worktree removed
        <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {units.length}
        </span>
      </h2>
      <p className="mb-3 text-[11px] text-slate-600">
        Finished work whose git worktree no longer exists — nothing left to clean up.
      </p>

      {units.length === 0 ? (
        <p className="text-sm text-slate-600">Nothing here.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {units.map((u) => (
                <tr key={u.unitId} className="bg-slate-950 hover:bg-slate-900/60">
                  <td className="px-3 py-2 font-mono text-slate-400">
                    {u.linearUrl ? (
                      <a
                        href={u.linearUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-400 hover:text-indigo-300"
                        title="Open in Linear"
                      >
                        {u.identifier} ↗
                      </a>
                    ) : (
                      u.identifier
                    )}
                  </td>
                  <td className="max-w-md truncate px-3 py-2 text-slate-200" title={u.title}>
                    {u.title}
                  </td>
                  <td className="px-3 py-2">
                    {u.linearStatus && (
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-300">
                        {u.linearStatus}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {u.pr ? (
                      <a
                        href={u.pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-violet-950 px-1.5 py-0.5 font-medium text-violet-300 hover:bg-violet-900"
                      >
                        PR{u.pr.number ? ` #${u.pr.number}` : ''}
                      </a>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{relTime(u.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
