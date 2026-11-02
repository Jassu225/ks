// Server component: resolves board config at request time (lib/boardConfig.ts)
// and hands it to the client board. The root layout resolves the same config
// for the shared header's data provider.
import { Board } from '@/components/Board';
import { loadBoardConfig } from '@/lib/boardConfig';

export const dynamic = 'force-dynamic';

export default function Page() {
  const config = loadBoardConfig();
  if (!config.projectId) {
    return (
      <div className="grid h-screen place-items-center bg-slate-950 px-6 text-center text-sm text-slate-400">
        <div className="max-w-xl">
          <p>No project configured (no `project.conf` in this board's data dir).</p>
          <p className="mt-1">
            Set one in{' '}
            <a href="/settings" className="text-indigo-400 underline hover:text-indigo-300">
              settings
            </a>
            , or run <code className="mx-1 rounded bg-slate-800 px-1">ks-flow set-project &lt;path&gt;</code>.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Reading: <code className="rounded bg-slate-800 px-1">{config.dataDir}</code>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            If that path looks wrong, the board was launched from the wrong place — relaunch with{' '}
            <code className="rounded bg-slate-800 px-1">ks-flow open</code> (it auto-finds your configured project).
          </p>
        </div>
      </div>
    );
  }
  return <Board config={config} />;
}
