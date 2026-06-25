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

  // GCS archive-on-removal.
  const [gcsEnabled, setGcsEnabled] = useState(false);
  const [gcsBucket, setGcsBucket] = useState('');
  // Non-empty when GCS_BUCKET is set in .env — it wins, so the field goes read-only.
  const [gcsBucketEnv, setGcsBucketEnv] = useState('');
  const [gcsPrefix, setGcsPrefix] = useState('');
  const [gcsSaving, setGcsSaving] = useState(false);
  const [gcsSaved, setGcsSaved] = useState(false);
  const [missingPkgs, setMissingPkgs] = useState<{ name: string; installHint: string }[]>([]);

  // Reminders.
  const [remEnabled, setRemEnabled] = useState(true);
  const [remInterval, setRemInterval] = useState(5);
  const [remCap, setRemCap] = useState(12);
  const [remDebounce, setRemDebounce] = useState(60);
  const [remSaving, setRemSaving] = useState(false);
  const [remSaved, setRemSaved] = useState(false);
  const [remMissing, setRemMissing] = useState<{ name: string; installHint: string }[]>([]);
  const [remInstalling, setRemInstalling] = useState(false);
  const [remInstallMsg, setRemInstallMsg] = useState<string | null>(null);

  // Notes page.
  const [notesEnabled, setNotesEnabled] = useState(false);
  const [notesSlack, setNotesSlack] = useState(false);
  const [notesLinear, setNotesLinear] = useState(false);
  const [slackTokenPresent, setSlackTokenPresent] = useState(false);
  const [linearKeyPresent, setLinearKeyPresent] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  const checkReminderPreflight = async (): Promise<void> => {
    try {
      const r = await fetch('/api/reminders-preflight');
      const d: { ok: boolean; missing: { name: string; installHint: string }[] } = await r.json();
      setRemMissing(d.ok ? [] : d.missing);
    } catch {
      setRemMissing([]);
    }
  };

  const installNotifier = async (): Promise<void> => {
    setRemInstalling(true);
    setRemInstallMsg(null);
    try {
      const r = await fetch('/api/reminders-preflight', { method: 'POST' });
      const d: { ok: boolean; output: string } = await r.json();
      setRemInstallMsg(d.ok ? 'Installed ✓' : `Install failed — run "brew install terminal-notifier" manually.`);
      if (d.ok) setRemMissing([]);
    } catch {
      setRemInstallMsg('Install request failed.');
    }
    setRemInstalling(false);
  };

  const checkPreflight = async (): Promise<void> => {
    try {
      const r = await fetch('/api/archive-preflight');
      const d: { ok: boolean; missing: { name: string; installHint: string }[] } = await r.json();
      setMissingPkgs(d.ok ? [] : d.missing);
    } catch {
      setMissingPkgs([]);
    }
  };

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
      .then(
        (s: {
          removeCommand?: string;
          gcsArchive?: { enabled?: boolean; bucket?: string; prefix?: string };
          gcsBucketEnv?: string;
          reminders?: {
            enabled?: boolean;
            stopIntervalMin?: number;
            capCount?: number;
            debounceSec?: number;
          };
          notes?: { enabled?: boolean; slack?: boolean; linear?: boolean };
          slackTokenPresent?: boolean;
          linearKeyPresent?: boolean;
        }) => {
          setRemoveCommand(s.removeCommand ?? '');
          setGcsEnabled(s.gcsArchive?.enabled === true);
          setGcsBucket(s.gcsArchive?.bucket ?? '');
          setGcsBucketEnv(s.gcsBucketEnv ?? '');
          setGcsPrefix(s.gcsArchive?.prefix ?? '');
          if (s.gcsArchive?.enabled) void checkPreflight();
          const remOn = s.reminders?.enabled !== false;
          setRemEnabled(remOn);
          if (typeof s.reminders?.stopIntervalMin === 'number') setRemInterval(s.reminders.stopIntervalMin);
          if (typeof s.reminders?.capCount === 'number') setRemCap(s.reminders.capCount);
          if (typeof s.reminders?.debounceSec === 'number') setRemDebounce(s.reminders.debounceSec);
          if (remOn) void checkReminderPreflight();
          setNotesEnabled(s.notes?.enabled === true);
          setNotesSlack(s.notes?.slack === true);
          setNotesLinear(s.notes?.linear === true);
          setSlackTokenPresent(s.slackTokenPresent === true);
          setLinearKeyPresent(s.linearKeyPresent === true);
        },
      )
      .catch(() => {});
  }, []);

  const saveReminders = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setRemSaving(true);
    setRemSaved(false);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reminders: {
            enabled: remEnabled,
            stopIntervalMin: remInterval,
            capCount: remCap,
            debounceSec: remDebounce,
          },
        }),
      });
      setRemSaved(true);
      setTimeout(() => setRemSaved(false), 2000);
    } catch {
      // best-effort
    }
    setRemSaving(false);
  };

  // Open $CLAUDE_PLUGIN_DATA/.env in the OS default text editor. The file is
  // never read or sent over HTTP — the server just hands the path to `open -t`.
  const editEnv = async (): Promise<void> => {
    try {
      await fetch('/api/open-env', { method: 'POST' });
    } catch {
      // best-effort — nothing to surface; the editor either opened or didn't
    }
  };

  const saveNotes = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setNotesSaving(true);
    setNotesSaved(false);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: { enabled: notesEnabled, slack: notesSlack, linear: notesLinear },
        }),
      });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch {
      // best-effort
    }
    setNotesSaving(false);
  };

  const toggleGcs = (next: boolean): void => {
    setGcsEnabled(next);
    setGcsSaved(false);
    if (next) void checkPreflight();
    else setMissingPkgs([]);
  };

  const saveGcs = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setGcsSaving(true);
    setGcsSaved(false);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gcsArchive: { enabled: gcsEnabled, bucket: gcsBucket, prefix: gcsPrefix },
        }),
      });
      setGcsSaved(true);
      setTimeout(() => setGcsSaved(false), 2000);
      if (gcsEnabled) void checkPreflight();
    } catch {
      // best-effort — surfaced via the lack of the saved tick
    }
    setGcsSaving(false);
  };

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
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950 px-5 py-3">
        <h1 className="text-lg font-bold">ks-flow · settings</h1>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => void editEnv()}
            title="Open $CLAUDE_PLUGIN_DATA/.env in your default text editor (not read or sent over the network)"
            className="rounded bg-slate-800 px-2 py-1 font-medium text-slate-200 hover:bg-slate-700"
          >
            Edit .env
          </button>
          <Link href="/" className="text-indigo-400 hover:text-indigo-300">
            ← back to board
          </Link>
        </div>
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

        <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Archive to Google Cloud Storage</h2>
          <p className="mt-1 text-xs text-slate-400">
            When enabled, removing a completed worktree first compresses its{' '}
            <span className="text-slate-300">transcript</span> and{' '}
            <span className="text-slate-300">workflow</span> folders into two{' '}
            <code className="text-slate-300">.tar.zst</code> archives (zstd <code>--ultra -22</code>)
            and uploads them to GCS. If archiving fails, the removal is{' '}
            <span className="text-slate-300">aborted</span> so nothing is deleted un-archived.
            Credentials are read from <code className="text-slate-300">$CLAUDE_PLUGIN_DATA/.env</code>{' '}
            (<code>GCS_CREDENTIALS</code>, or <code>GCS_CLIENT_EMAIL</code> +{' '}
            <code>GCS_PRIVATE_KEY</code>; optional <code>GCS_PROJECT_ID</code> /{' '}
            <code>GCS_BUCKET</code>) — never stored here.
          </p>

          {gcsEnabled && missingPkgs.length > 0 && (
            <div className="mt-4 rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-200">
              <div className="font-medium">Missing required package{missingPkgs.length > 1 ? 's' : ''}</div>
              <p className="mt-1 text-xs text-amber-300/90">
                Archiving needs these installed. Run:
              </p>
              <ul className="mt-1 space-y-1 font-mono text-[11px] text-amber-200">
                {missingPkgs.map((p) => (
                  <li key={p.name}>$ {p.installHint}</li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={saveGcs} className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={gcsEnabled}
                onChange={(e) => toggleGcs(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-800"
              />
              Enable GCS archive on worktree removal
            </label>
            <div>
              <label className="block text-xs text-slate-400">Bucket</label>
              {gcsBucketEnv ? (
                <>
                  <input
                    type="text"
                    value={gcsBucketEnv}
                    readOnly
                    disabled
                    spellCheck={false}
                    className="mt-1 w-full cursor-not-allowed rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-400"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Set via <code>GCS_BUCKET</code> in <code>.env</code> — it overrides this field.
                    Unset it there to edit the bucket here.
                  </p>
                </>
              ) : (
                <input
                  type="text"
                  value={gcsBucket}
                  onChange={(e) => setGcsBucket(e.target.value)}
                  placeholder="my-ks-flow-archives"
                  spellCheck={false}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              )}
            </div>
            <div>
              <label className="block text-xs text-slate-400">Object prefix (optional)</label>
              <input
                type="text"
                value={gcsPrefix}
                onChange={(e) => setGcsPrefix(e.target.value)}
                placeholder="ks-flow"
                spellCheck={false}
                className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Objects land at{' '}
                <code>
                  gs://&lt;bucket&gt;/{gcsPrefix ? `${gcsPrefix}/` : ''}&lt;identifier&gt;/{'{transcript,workflow}'}.tar.zst
                </code>
              </p>
            </div>
            <button
              type="submit"
              disabled={gcsSaving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {gcsSaving ? 'Saving…' : gcsSaved ? 'Saved ✓' : 'Save archive settings'}
            </button>
          </form>
        </section>

        <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Reminders</h2>
          <p className="mt-1 text-xs text-slate-400">
            When a session stops (idle awaiting you), notify immediately then repeat every N minutes
            until it resumes, ends, or hits the cap. Pause a session's nudge from its card; set
            per-card reminders with the <span className="text-slate-300">⏰</span> control. On by
            default. <span className="text-slate-300">Enable reminders</span> is the master switch —
            turning it off silences <em>everything</em>: stop-nudges, per-card reminders, and
            Notes-page reminders.
          </p>

          <div className="mt-3 rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
            Notifications auto-dismiss after a few seconds by default. To make them stay until you
            dismiss them, set the notifier to <span className="text-slate-300">Alerts</span>:
            System Settings → Notifications → <span className="text-slate-300">terminal-notifier</span> →
            Alert style: Alerts.
            <button
              type="button"
              onClick={() => void fetch('/api/open-notification-settings', { method: 'POST' })}
              className="ml-2 rounded bg-slate-700 px-2 py-1 text-[11px] font-medium text-slate-100 hover:bg-slate-600"
            >
              Open Notification Settings
            </button>
          </div>

          {remEnabled && remMissing.length > 0 && (
            <div className="mt-4 rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-200">
              <div className="font-medium">terminal-notifier is required for notifications</div>
              <p className="mt-1 text-xs text-amber-300/90">
                Without it, reminders (and waiting/permission alerts) are silent. Install it now:
              </p>
              <button
                type="button"
                onClick={installNotifier}
                disabled={remInstalling}
                className="mt-2 rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {remInstalling ? 'Installing…' : 'Install terminal-notifier'}
              </button>
              <span className="ml-2 font-mono text-[11px] text-amber-300/80">brew install terminal-notifier</span>
              {remInstallMsg && <p className="mt-1 text-xs text-amber-200">{remInstallMsg}</p>}
            </div>
          )}

          <form onSubmit={saveReminders} className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={remEnabled}
                onChange={(e) => {
                  setRemEnabled(e.target.checked);
                  if (e.target.checked) void checkReminderPreflight();
                  else setRemMissing([]);
                }}
                className="h-4 w-4 rounded border-slate-600 bg-slate-800"
              />
              Enable reminders
            </label>
            <div className="flex gap-4">
              <div>
                <label className="block text-xs text-slate-400">Idle debounce (sec)</label>
                <input
                  type="number"
                  min={0}
                  value={remDebounce}
                  onChange={(e) => setRemDebounce(Math.max(0, Number(e.target.value) || 0))}
                  className="mt-1 w-28 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Quiet (incl. teammates) before the first notice.
                </p>
              </div>
              <div>
                <label className="block text-xs text-slate-400">Stop-nudge interval (min)</label>
                <input
                  type="number"
                  min={1}
                  value={remInterval}
                  onChange={(e) => setRemInterval(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 w-28 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400">Max nudges (cap)</label>
                <input
                  type="number"
                  min={1}
                  value={remCap}
                  onChange={(e) => setRemCap(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 w-28 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={remSaving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {remSaving ? 'Saving…' : remSaved ? 'Saved ✓' : 'Save reminder settings'}
            </button>
          </form>
        </section>

        <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Notes</h2>
          <p className="mt-1 text-xs text-slate-400">
            A <Link href="/notes" className="text-indigo-400 hover:text-indigo-300">Notes</Link> page
            for saved notes & reminders, in three sections. The generic section shows whenever Notes
            is on. The <span className="text-slate-300">Slack</span> and{' '}
            <span className="text-slate-300">Linear</span> sections also need their token in{' '}
            <code className="text-slate-300">$CLAUDE_PLUGIN_DATA/.env</code> (
            <code className="text-slate-300">SLACK_TOKEN</code> /{' '}
            <code className="text-slate-300">LINEAR_API_KEY</code>; set with{' '}
            <span className="text-slate-300">Edit .env</span> in the header). In Slack you paste a
            message link and the text + date are fetched via the token (Slack can't list saved
            messages — that API was retired). A note reminder fires at its due time, then nags once a
            day until cleared.
          </p>

          <form onSubmit={saveNotes} className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={notesEnabled}
                onChange={(e) => setNotesEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-800"
              />
              Enable Notes
            </label>

            <div className="space-y-2 border-t border-slate-800 pt-3">
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={notesSlack}
                  disabled={!notesEnabled}
                  onChange={(e) => setNotesSlack(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 disabled:opacity-40"
                />
                Slack
                {notesSlack &&
                  (slackTokenPresent ? (
                    <span className="text-[11px] text-emerald-400">SLACK_TOKEN detected ✓</span>
                  ) : (
                    <span className="text-[11px] text-amber-400">
                      no SLACK_TOKEN in .env — section stays hidden
                    </span>
                  ))}
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={notesLinear}
                  disabled={!notesEnabled}
                  onChange={(e) => setNotesLinear(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 disabled:opacity-40"
                />
                Linear <span className="text-[11px] text-slate-500">(placeholder for now)</span>
                {notesLinear &&
                  (linearKeyPresent ? (
                    <span className="text-[11px] text-emerald-400">LINEAR_API_KEY detected ✓</span>
                  ) : (
                    <span className="text-[11px] text-amber-400">
                      no LINEAR_API_KEY in .env — section stays hidden
                    </span>
                  ))}
              </label>
            </div>

            <button
              type="submit"
              disabled={notesSaving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {notesSaving ? 'Saving…' : notesSaved ? 'Saved ✓' : 'Save notes settings'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
