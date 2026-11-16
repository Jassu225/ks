'use client';
// Settings — re-point the tracked project from the board. Enter an absolute
// repo path; the server validates it's a git repo, derives the git-common-dir
// + projectId, rewrites project.conf, and restarts the daemon.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/AppHeader';
import {
  DeviceChip,
  MASTER_STALE_WARN_MS,
  agoText,
  deviceLabel,
  isDeviceStale,
} from '@/components/DeviceChip';
import { useShared } from '@/lib/boardData';
import type { DeviceDoc } from '@/lib/types';
import { compareSemver } from '@/lib/versioning';

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

/** board-settings.json `briefing` (docs/briefing.md). */
interface BriefingSettingsForm {
  enabled: boolean;
  schedule: string[];
  names: string[];
  halfTime: string[];
}

type DevicesChange =
  | { action: 'rename'; deviceId: string; name: string | null }
  | { action: 'forget'; deviceId: string; forgotten: boolean }
  | { action: 'master'; deviceId: string };

async function postDevices(changes: DevicesChange[]): Promise<void> {
  const r = await fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  if (!r.ok) {
    const d: { error?: string } = await r.json().catch(() => ({}));
    throw new Error(d.error ?? `save failed (${r.status})`);
  }
}

/** The one-off device backfill, run once on the device that has used ks-flow so far. */
const BACKFILL_CMD = 'npx tsx ../scripts/one-off/backfill-devices.ts --dry-run';

/**
 * Settings → Devices: every device that runs ks-flow on this store (any
 * number), live from the board's subscription. Names and the master are a
 * draft until saved; Forget (stale devices only) and taking a device back
 * write at once. Store-only (/api/devices): nothing goes to board-settings.json.
 */
/** A device's ks-flow version (amber when behind the store's), and "dev build". */
function DeviceVersion({ device: d, storeVersion }: { device: DeviceDoc; storeVersion: string | null }) {
  const behind = !!storeVersion && compareSemver(storeVersion, d.daemonVersion) > 0;
  return (
    <>
      <span
        className={`font-mono text-[11px] ${behind ? 'text-amber-300' : 'text-slate-400'}`}
        title={
          behind
            ? `ks-flow ${d.daemonVersion || 'unknown'} is behind the store's ${storeVersion}: it updates itself`
            : `ks-flow ${d.daemonVersion || 'unknown'}${typeof d.schemaVersion === 'number' ? ` (data format ${d.schemaVersion})` : ''}`
        }
      >
        v{d.daemonVersion || '?'}
        {behind && ` → ${storeVersion}`}
      </span>
      {d.devBuild && (
        <span
          className="rounded border border-slate-700 px-1 text-[10px] text-slate-400"
          title={`dev build${d.devReason ? `: ${d.devReason}` : ''} — it never raises the store's version and never updates itself`}
        >
          dev build
        </span>
      )}
    </>
  );
}

function DevicesSection() {
  const { board, now } = useShared();
  const { devices, settings, self } = board;
  const [names, setNames] = useState<Record<string, string>>({});
  const [master, setMaster] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const currentMaster = settings?.masterDeviceId ?? null;
  const shownMaster = master ?? currentMaster;
  const masterDoc = devices.find((d) => d.deviceId === currentMaster) ?? null;
  const masterStale = !!currentMaster && !!masterDoc && isDeviceStale(masterDoc, now, MASTER_STALE_WARN_MS);

  // This device first, then by name; forgotten devices last.
  const rows = [...devices].sort(
    (a, b) =>
      Number(a.forgotten === true) - Number(b.forgotten === true) ||
      Number(b.deviceId === self) - Number(a.deviceId === self) ||
      deviceLabel(a, a.deviceId).localeCompare(deviceLabel(b, b.deviceId)),
  );

  const nameOf = (d: DeviceDoc): string => names[d.deviceId] ?? d.name ?? '';
  const changes = (): DevicesChange[] => {
    const out: DevicesChange[] = [];
    for (const d of devices) {
      const draft = names[d.deviceId];
      if (draft !== undefined && draft.trim() !== (d.name ?? '').trim()) {
        out.push({ action: 'rename', deviceId: d.deviceId, name: draft.trim() || null });
      }
    }
    if (master && master !== currentMaster) out.push({ action: 'master', deviceId: master });
    return out;
  };
  const dirty = changes().length > 0;

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const list = changes();
    if (list.length === 0) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await postDevices(list);
      // The live subscription brings the new values; drop the drafts.
      setNames({});
      setMaster(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message || 'Save failed — is the board server still running?');
    }
    setSaving(false);
  };

  const setForgotten = async (d: DeviceDoc, forgotten: boolean): Promise<void> => {
    const label = deviceLabel(d, d.deviceId);
    if (
      forgotten &&
      !window.confirm(
        `Forget ${label}? Its cards stay in the store, tagged to it, and show as removed cards ` +
          `(Done, behind "show removed"). You can take it back later.`,
      )
    ) {
      return;
    }
    setBusyId(d.deviceId);
    setError(null);
    try {
      await postDevices([{ action: 'forget', deviceId: d.deviceId, forgotten }]);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusyId(null);
  };

  return (
    <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5" aria-labelledby="devices-settings">
      <h2 id="devices-settings" className="text-sm font-semibold text-slate-200">
        Devices
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        Every device whose ks-flow writes to this store. Each card belongs to the device its worktree is on;
        only that device backs it up, refreshes or removes it. Your name for a device shows on its chips. The
        master session runs on one device: Brief me and Restart from any other device are sent to it.
      </p>

      {!settings ? (
        <div className="mt-4 rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
          <div className="font-medium">This store is not set up for devices yet: run the device backfill</div>
          <p className="mt-1 text-amber-300/90">
            Run it once, on the device that has used ks-flow so far, from <code>plugins/ks-flow/src</code>: it
            tags the existing records to that device and makes it the master device. Check the counts with{' '}
            <code>--dry-run</code> first, then run it without. Then restart the daemon and the board.
          </p>
          <pre className="mt-2 overflow-x-auto font-mono text-[11px] text-amber-200">{BACKFILL_CMD}</pre>
        </div>
      ) : (
        <>
          {masterStale && (
            <div
              role="alert"
              className="mt-4 rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs text-amber-200"
            >
              The master device {deviceLabel(masterDoc, masterDoc!.deviceId)} was last seen{' '}
              {agoText(masterDoc?.lastSeenAt, now)}: no Briefing runs until it is back. Pick a new master device
              below and save.
            </div>
          )}
          <form onSubmit={save} className="mt-4 space-y-3">
            {rows.length === 0 && <p className="text-xs text-slate-500">No device has checked in yet.</p>}
            <ul className="space-y-2">
              {rows.map((d) => {
                const isSelf = d.deviceId === self;
                const forgotten = d.forgotten === true;
                const stale = isDeviceStale(d, now);
                const canForget = !forgotten && !isSelf && stale && d.deviceId !== currentMaster;
                const worktrees = d.worktreePaths?.length ?? 0;
                return (
                  <li
                    key={d.deviceId}
                    className={`rounded border border-slate-800 bg-slate-950/40 p-3 ${forgotten ? 'opacity-60' : ''}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <DeviceChip deviceId={d.deviceId} always />
                      <code className="font-mono text-[11px] text-slate-500" title={d.deviceId}>
                        {d.deviceId.slice(0, 8)}
                      </code>
                      {isSelf && <span className="text-[11px] font-medium text-emerald-400">this device</span>}
                      {forgotten && <span className="text-[11px] text-slate-500">removed device</span>}
                      <DeviceVersion device={d} storeVersion={settings.version ?? null} />
                      <div className="grow" />
                      <label
                        className={`flex items-center gap-1.5 text-xs ${forgotten ? 'text-slate-600' : 'text-slate-300'}`}
                        title={
                          forgotten
                            ? 'A forgotten device cannot run the master'
                            : stale
                              ? `${deviceLabel(d, d.deviceId)} is asleep or offline: the master starts when it is back`
                              : 'Run the master session on this device'
                        }
                      >
                        <input
                          type="radio"
                          name="master-device"
                          checked={shownMaster === d.deviceId}
                          disabled={forgotten}
                          onChange={() => {
                            setMaster(d.deviceId);
                            setSaved(false);
                          }}
                          className="accent-indigo-500"
                        />
                        Master
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label htmlFor={`device-name-${d.deviceId}`} className="sr-only">
                        Name for {d.defaultName}
                      </label>
                      <input
                        id={`device-name-${d.deviceId}`}
                        type="text"
                        value={nameOf(d)}
                        maxLength={40}
                        disabled={forgotten}
                        onChange={(e) => {
                          const v = e.target.value;
                          setNames((n) => ({ ...n, [d.deviceId]: v }));
                          setSaved(false);
                        }}
                        placeholder={d.defaultName || 'name'}
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
                      />
                      {canForget && (
                        <button
                          type="button"
                          onClick={() => void setForgotten(d, true)}
                          disabled={busyId === d.deviceId}
                          title="A stale device (a replaced Mac, a new device id): its cards become removed cards"
                          className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-red-950 hover:text-red-300 disabled:opacity-50"
                        >
                          Forget
                        </button>
                      )}
                      {forgotten && (
                        <button
                          type="button"
                          onClick={() => void setForgotten(d, false)}
                          disabled={busyId === d.deviceId}
                          title="Take this device back: its cards show again wherever its worktrees are"
                          className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                        >
                          Take back
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      <span className={stale && !forgotten ? 'text-amber-400/80' : ''}>
                        last seen {agoText(d.lastSeenAt, now)}
                      </span>
                      {d.lastSeenAt && ` (${new Date(d.lastSeenAt).toLocaleString()})`}
                      {d.platform && ` · ${d.platform}`}
                      {d.daemonVersion && ` · daemon ${d.daemonVersion}`}
                      {` · ${worktrees} worktree${worktrees === 1 ? '' : 's'}`}
                    </p>
                  </li>
                );
              })}
            </ul>
            {currentMaster && !masterDoc && (
              <p className="text-[11px] text-amber-400">
                The master device ({currentMaster.slice(0, 8)}) has no device record: pick a master above.
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={saving || !dirty}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save devices'}
            </button>
            <p className="text-[11px] text-slate-500">
              An empty name goes back to the device&apos;s own name. A new master device takes over within a
              minute; the old one stops supervising the master.
            </p>
          </form>
        </>
      )}
    </section>
  );
}

/** /api/settings' `warning` for a shared block: saved here, not yet in the store. */
function SaveWarning({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="mt-2 text-xs text-amber-400">{text}</p>;
}

export default function Settings() {
  const [path, setPath] = useState('');
  const [current, setCurrent] = useState<Conf | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetResult | null>(null);
  const router = useRouter();

  // Worktree-removal command (run by a card's Remove).
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

  // Briefing (the master session's scheduled Slack passes). Defaults mirror
  // src/lib/boardsettings.ts briefingSettings().
  const [brEnabled, setBrEnabled] = useState(false);
  const [brSchedule, setBrSchedule] = useState<string[]>(['00:00', '06:00', '12:00', '18:00']);
  const [brSlot, setBrSlot] = useState('09:00');
  const [brNames, setBrNames] = useState('Jaswanth');
  const [brHalfTime, setBrHalfTime] = useState('');
  const [brSaving, setBrSaving] = useState(false);
  const [brSaved, setBrSaved] = useState(false);
  const [brError, setBrError] = useState<string | null>(null);

  // A shared block's save (briefing, notes, reminders, gcsArchive) that reached
  // this device's file but not the store: /api/settings answers with `warning`
  // (the daemon pushes it to meta/settings shortly). Shown under that Save button.
  const [saveWarn, setSaveWarn] = useState<Record<string, string>>({});
  const noteWarning = async (section: string, r: Response): Promise<void> => {
    const d = (await r.json().catch(() => null)) as { warning?: unknown } | null;
    setSaveWarn((w) => {
      const next = { ...w };
      if (typeof d?.warning === 'string' && d.warning) next[section] = d.warning;
      else delete next[section];
      return next;
    });
  };

  const splitList = (s: string): string[] =>
    [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];

  const addSlot = (): void => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(brSlot)) return;
    setBrSchedule((s) => [...new Set([...s, brSlot])].sort());
    setBrSaved(false);
  };

  const saveBriefing = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBrSaving(true);
    setBrSaved(false);
    setBrError(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          briefing: {
            enabled: brEnabled,
            schedule: brSchedule,
            names: splitList(brNames),
            halfTime: splitList(brHalfTime),
          },
        }),
      });
      if (!r.ok) throw new Error();
      const d: { briefing?: BriefingSettingsForm; warning?: string } = await r.json();
      if (d.briefing) applyBriefing(d.briefing);
      setSaveWarn((w) => {
        const next = { ...w };
        if (d.warning) next.briefing = d.warning;
        else delete next.briefing;
        return next;
      });
      setBrSaved(true);
      setTimeout(() => setBrSaved(false), 2000);
    } catch {
      setBrError('Save failed — is the board server still running?');
    }
    setBrSaving(false);
  };

  const applyBriefing = (b: Partial<BriefingSettingsForm>): void => {
    setBrEnabled(b.enabled === true);
    if (Array.isArray(b.schedule)) setBrSchedule(b.schedule);
    if (Array.isArray(b.names)) setBrNames(b.names.join(', '));
    if (Array.isArray(b.halfTime)) setBrHalfTime(b.halfTime.join(', '));
  };

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
          briefing?: Partial<BriefingSettingsForm>;
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
          if (s.briefing) applyBriefing(s.briefing);
        },
      )
      .catch(() => {});
  }, []);

  const saveReminders = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setRemSaving(true);
    setRemSaved(false);
    try {
      const r = await fetch('/api/settings', {
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
      await noteWarning('reminders', r);
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
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: { enabled: notesEnabled, slack: notesSlack, linear: notesLinear },
        }),
      });
      await noteWarning('notes', r);
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
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gcsArchive: { enabled: gcsEnabled, bucket: gcsBucket, prefix: gcsPrefix },
        }),
      });
      await noteWarning('gcsArchive', r);
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
        // The layout read the old project.conf; re-render it so every page's
        // shared subscription follows the new project.
        router.refresh();
        setCurrent({ projectPath: data.projectPath, commonDir: data.commonDir, projectId: data.projectId });
      }
    } catch {
      setError('Request failed — is the board server still running?');
    }
    setSaving(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AppHeader
        toolbar={
          <>
            <h1 className="text-sm font-semibold text-slate-200">Settings</h1>
            <div className="grow" />
            <button
              type="button"
              onClick={() => void editEnv()}
              title="Open $CLAUDE_PLUGIN_DATA/.env in your default text editor (not read or sent over the network)"
              className="rounded bg-slate-800 px-2 py-1 font-medium text-slate-200 hover:bg-slate-700"
            >
              Edit .env
            </button>
          </>
        }
      />

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
            Run when you click a card&apos;s <span className="text-slate-300">Remove</span>. Executed with{' '}
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
              placeholder="remove_worktree -D {{path}}  (default)"
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
            When enabled, removing a worktree first compresses its{' '}
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
            <SaveWarning text={saveWarn.gcsArchive} />
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
            <SaveWarning text={saveWarn.reminders} />
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
            <SaveWarning text={saveWarn.notes} />
          </form>
        </section>

        <DevicesSection />

        <section className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-5" aria-labelledby="briefing-settings">
          <h2 id="briefing-settings" className="text-sm font-semibold text-slate-200">
            Briefing
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            A long-running master Claude session reads Slack (DMs, @mentions, your name, your own
            promises) and puts what needs you on the{' '}
            <Link href="/briefing" className="text-indigo-400 hover:text-indigo-300">
              Briefing
            </Link>{' '}
            page with a due time. Only you archive items there.
          </p>

          <form onSubmit={saveBriefing} className="mt-4 space-y-4">
            <div>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={brEnabled}
                  onChange={(e) => {
                    setBrEnabled(e.target.checked);
                    setBrSaved(false);
                  }}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                />
                Enable scheduled briefings
              </label>
              <p className="mt-1 pl-6 text-[11px] text-slate-500">
                When on, the daemon asks the master for a Slack pass at each time below, and starts
                the master (or restarts it) when it is down. Off: nothing is scheduled; “Brief me
                now” on the Briefing page still works while a master runs.
              </p>
            </div>

            <fieldset className="border-t border-slate-800 pt-3">
              <legend className="text-xs text-slate-400">Schedule (local time)</legend>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {brSchedule.length === 0 && (
                  <span className="text-[11px] text-amber-400">No times: nothing will be scheduled.</span>
                )}
                {brSchedule.map((slot) => (
                  <span
                    key={slot}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800 py-0.5 pl-2.5 pr-1 font-mono text-xs text-slate-200"
                  >
                    {slot}
                    <button
                      type="button"
                      aria-label={`Remove ${slot}`}
                      onClick={() => {
                        setBrSchedule((s) => s.filter((x) => x !== slot));
                        setBrSaved(false);
                      }}
                      className="rounded-full px-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <label htmlFor="br-slot" className="sr-only">
                  Add a time
                </label>
                <input
                  id="br-slot"
                  type="time"
                  value={brSlot}
                  onChange={(e) => setBrSlot(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={addSlot}
                  disabled={brSchedule.includes(brSlot)}
                  className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  Add time
                </button>
              </div>
            </fieldset>

            <div className="border-t border-slate-800 pt-3">
              <label htmlFor="br-names" className="block text-xs text-slate-400">
                Your names
              </label>
              <input
                id="br-names"
                type="text"
                value={brNames}
                onChange={(e) => {
                  setBrNames(e.target.value);
                  setBrSaved(false);
                }}
                placeholder="Jaswanth"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Comma-separated. A message that writes one of these anywhere counts as written to you.
              </p>
            </div>

            <div>
              <label htmlFor="br-halftime" className="block text-xs text-slate-400">
                Half-time senders (Slack user ids)
              </label>
              <input
                id="br-halftime"
                type="text"
                value={brHalfTime}
                onChange={(e) => {
                  setBrHalfTime(e.target.value);
                  setBrSaved(false);
                }}
                placeholder="U012ABCDEF, U034GHIJKL"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Asks from these people get half the usual window (a DM is due in 2h, not 4h). Empty by default.
              </p>
              {splitList(brHalfTime).some((id) => !/^[UW][A-Z0-9]+$/.test(id)) && (
                <p className="mt-1 text-[11px] text-amber-400">
                  Slack user ids look like U012ABCDEF (not names).
                </p>
              )}
            </div>

            {brError && (
              <p role="alert" className="text-xs text-red-400">
                {brError}
              </p>
            )}
            <button
              type="submit"
              disabled={brSaving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {brSaving ? 'Saving…' : brSaved ? 'Saved ✓' : 'Save briefing settings'}
            </button>
            <SaveWarning text={saveWarn.briefing} />
          </form>
        </section>
      </main>
    </div>
  );
}
