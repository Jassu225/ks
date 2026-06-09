'use client';
// Settings — re-point the tracked project from the board. Enter an absolute
// repo path; the server validates it's a git repo, derives the git-common-dir
// + projectId, rewrites project.conf, and restarts the daemon.
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Conf {
  projectPath: string;
  commonDir: string;
  projectId: string;
}
interface SetResult extends Conf {
  ok: true;
  worktrees: number;
  daemon: string;
}

export default function Settings() {
  const [path, setPath] = useState('');
  const [current, setCurrent] = useState<Conf | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetResult | null>(null);

  // Worktree-removal command (run from the Completed worktrees view).
  const [removeCommand, setRemoveCommand] = useState('');
  const [cmdSaving, setCmdSaving] = useState(false);
  const [cmdSaved, setCmdSaved] = useState(false);

  const browse = async (): Promise<void> => {
    setPicking(true);
    setError(null);
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' });
      const data = await res.json();
      if (data.path) setPath(data.path);
      else if (data.error) setError(data.error);
    } catch {
      setError('Could not open the folder picker.');
    }
    setPicking(false);
  };

  useEffect(() => {
    fetch('/api/project')
      .then((r) => r.json())
      .then((c: Conf) => {
        setCurrent(c);
        if (c.projectPath) setPath(c.projectPath);
      })
      .catch(() => {});
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { removeCommand?: string }) => setRemoveCommand(s.removeCommand ?? ''))
      .catch(() => {});
  }, []);

  const saveCommand = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setCmdSaving(true);
    setCmdSaved(false);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeCommand }),
      });
      setCmdSaved(true);
      setTimeout(() => setCmdSaved(false), 2000);
    } catch {
      // best-effort — surfaced via the lack of the saved tick
    }
    setCmdSaving(false);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Failed to set project.');
      else {
        setResult(data);
        setCurrent({ projectPath: data.projectPath, commonDir: data.commonDir, projectId: data.projectId });
      }
    } catch {
      setError('Request failed — is the board server still running?');
    }
    setSaving(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h1 className="text-lg font-bold">ks-flow · settings</h1>
        <Link href="/" className="text-xs text-indigo-400 hover:text-indigo-300">
          ← back to board
        </Link>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-8">
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Tracked project</h2>
          <p className="mt-1 text-xs text-slate-400">
            Absolute path to the repo to track. All of its git worktrees are tracked too. The
            daemon re-points and re-backfills on save.
          </p>

          <form onSubmit={submit} className="mt-4 space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/Users/you/code/your-repo"
                spellCheck={false}
                className="flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={browse}
                disabled={picking}
                className="shrink-0 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                {picking ? 'Opening…' : 'Browse…'}
              </button>
            </div>
            <button
              type="submit"
              disabled={saving || !path.trim()}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Validating…' : 'Set project'}
            </button>
          </form>

          {error && (
            <div className="mt-4 rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-4 rounded border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
              <div className="font-medium">Project set ✓</div>
              <dl className="mt-2 space-y-1 font-mono text-[11px] text-emerald-300/90">
                <div>common-dir: {result.commonDir}</div>
                <div>projectId: {result.projectId}</div>
                <div>worktrees: {result.worktrees}</div>
                <div>daemon: {result.daemon}</div>
              </dl>
            </div>
          )}

          {!result && current?.commonDir && (
            <dl className="mt-4 space-y-1 border-t border-slate-800 pt-4 font-mono text-[11px] text-slate-400">
              <div>current common-dir: {current.commonDir}</div>
              <div>current projectId: {current.projectId}</div>
            </dl>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Worktree removal command</h2>
          <p className="mt-1 text-xs text-slate-400">
            Run from the <span className="text-slate-300">Completed worktrees</span> view when you
            click <span className="text-slate-300">Remove</span>. Executed with{' '}
            <code className="text-slate-300">zsh -c</code> from the project root. Use{' '}
            <code className="text-slate-300">{'{{path}}'}</code>,{' '}
            <code className="text-slate-300">{'{{identifier}}'}</code>, or{' '}
            <code className="text-slate-300">{'{{title}}'}</code> as placeholders (also available as{' '}
            <code className="text-slate-300">$KS_WORKTREE</code>,{' '}
            <code className="text-slate-300">$KS_IDENTIFIER</code>,{' '}
            <code className="text-slate-300">$KS_TITLE</code>).
          </p>

          <form onSubmit={saveCommand} className="mt-4 space-y-3">
            <input
              type="text"
              value={removeCommand}
              onChange={(e) => setRemoveCommand(e.target.value)}
              placeholder="git worktree remove {{path}}"
              spellCheck={false}
              className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={cmdSaving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {cmdSaving ? 'Saving…' : cmdSaved ? 'Saved ✓' : 'Save command'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
