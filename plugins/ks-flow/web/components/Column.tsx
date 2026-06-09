import type { PhaseRef, SessionDoc, WorkUnitDoc } from '@/lib/types';
import { WorkUnitCard } from './SessionCard';

export function Column({
  phase,
  units,
  sessions,
  now,
}: {
  phase: PhaseRef;
  units: WorkUnitDoc[];
  sessions: SessionDoc[];
  now: number;
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl bg-slate-900/60">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-200">
          <span className="mr-1.5 font-mono text-xs text-slate-500">{phase.number}</span>
          {phase.name}
        </h2>
        <span className="rounded-full bg-slate-800 px-2 text-xs text-slate-400">
          {units.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-2 pb-3">
        {[...units]
          // Worktree-backed units first (active dev); the rest sink + dim.
          .sort((a, b) => (a.worktreeDir ? 0 : 1) - (b.worktreeDir ? 0 : 1))
          .map((u) => (
            <WorkUnitCard
              key={u.unitId}
              unit={u}
              sessions={sessions}
              now={now}
              dimmed={!u.worktreeDir}
            />
          ))}
        {units.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-xs text-slate-600">
            empty
          </div>
        )}
      </div>
    </div>
  );
}
