'use client';
// The header every page shares: ks-flow + project, the page tabs, then the
// bell (briefing items hot or overdue), the Inbox button, the master chip, and
// the Processes / Settings icons. A page's own controls go in `toolbar`, a
// slim second row under it (the board's swimlanes, refresh, backup, kill…).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useShared } from '@/lib/boardData';
import type { DeviceMasterStatus, MasterStatus } from '@/lib/types';
import { versionNotices } from '@/lib/versioning';
import { DeviceChip, agoText, deviceLabel, isDeviceStale } from './DeviceChip';
import { BellIcon, GearIcon, InboxIcon, ProcessesIcon, WarningIcon } from './icons';

const TABS: { href: string; label: string; notesOnly?: boolean }[] = [
  { href: '/', label: 'Board' },
  { href: '/briefing', label: 'Briefing' },
  { href: '/daily', label: 'Daily log' },
  { href: '/notes', label: 'Notes', notesOnly: true },
  { href: '/activity', label: 'Activity Log' },
];

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;

export function masterLabel(m: MasterStatus | null): { text: string; dot: string; cls: string } {
  switch (m?.state) {
    case 'live':
      return { text: 'idle', dot: 'bg-green-500', cls: 'border-green-900 text-green-300' };
    case 'busy':
      return { text: 'busy', dot: 'bg-indigo-400 animate-pulse', cls: 'border-indigo-800 text-indigo-200' };
    case 'stale':
      return { text: 'no heartbeat', dot: 'bg-amber-400', cls: 'border-amber-900 text-amber-300' };
    case 'starting':
      return { text: 'starting', dot: 'bg-sky-400 animate-pulse', cls: 'border-sky-900 text-sky-300' };
    case 'down':
      return { text: 'down', dot: 'bg-red-500', cls: 'border-red-900 text-red-300' };
    case 'none':
      return { text: 'not started', dot: 'bg-slate-500', cls: 'border-slate-700 text-slate-400' };
    default:
      return { text: '…', dot: 'bg-slate-600', cls: 'border-slate-800 text-slate-500' };
  }
}

function masterTitle(m: MasterStatus | null): string {
  if (!m) return 'Master: checking…';
  if (m.state === 'none') return 'Master: no session.json yet — the daemon starts it.';
  const lines = [`Master session ${m.session?.sessionId ?? '?'}`];
  if (m.session?.tmuxPane) lines.push(`tmux ${m.session.tmuxPane}`);
  if (m.heartbeatAgeMs != null) lines.push(`heartbeat ${Math.round(m.heartbeatAgeMs / 1000)}s ago`);
  if (m.state === 'starting') lines.push('starting up — Claude is still loading');
  else if (!m.alive) lines.push('process not running — the daemon restarts it');
  if (m.pending.length) lines.push(`${m.pending.length} request${m.pending.length === 1 ? '' : 's'} waiting`);
  return lines.join('\n');
}

/**
 * The master status another device publishes in devices/{id}.master (the full
 * board MasterStatus plus heartbeatAt, pid, publishedAt), in the board's shape.
 * The heartbeat's age is computed here from heartbeatAt: the stored
 * heartbeatAgeMs is as old as the publish (written on change, at least every
 * ~30 s while the master lives). `briefing` falls back to meta/settings.
 */
export function masterFromDevice(
  m: DeviceMasterStatus,
  now: number,
  settingsBriefing?: Record<string, unknown> | null,
): MasterStatus {
  const STATES: MasterStatus['state'][] = ['none', 'starting', 'down', 'stale', 'busy', 'live'];
  const state = STATES.includes(m.state as MasterStatus['state']) ? (m.state as MasterStatus['state']) : 'none';
  const hb = m.heartbeatAt ? Date.parse(m.heartbeatAt) : NaN;
  const sb = settingsBriefing ?? null;
  const briefing =
    (m.briefing as MasterStatus['briefing'] | undefined) ??
    (sb
      ? { enabled: sb.enabled === true, schedule: Array.isArray(sb.schedule) ? (sb.schedule as string[]) : [] }
      : { enabled: false, schedule: [] });
  return {
    state,
    session: (m.session as MasterStatus['session']) ?? null,
    heartbeat: (m.heartbeat as MasterStatus['heartbeat']) ?? null,
    alive: typeof m.alive === 'boolean' ? m.alive : state === 'live' || state === 'busy' || state === 'stale',
    heartbeatAgeMs: Number.isFinite(hb) ? Math.max(0, now - hb) : null,
    bridgeSessionId: m.bridgeSessionId ?? null,
    pending: Array.isArray(m.pending) ? (m.pending as string[]) : [],
    briefing,
  };
}

export function MasterChip() {
  const { master: served, board, now } = useShared();
  // The master runs on the device chosen in Settings → Devices. Elsewhere, its
  // status is what that device's daemon publishes in devices/{id}.master: read
  // live from the store here, with /api/briefing/master (polled every 15 s; it
  // reads the same doc and adds `device`) as the fallback.
  const masterId = board.settings?.masterDeviceId ?? served?.device?.deviceId ?? null;
  const remote = !!masterId && masterId !== board.self;
  const dev = remote ? (board.devices.find((d) => d.deviceId === masterId) ?? null) : null;
  const name = remote ? (dev ? deviceLabel(dev, masterId) : (served?.device?.name ?? masterId.slice(0, 8))) : null;
  // Offline as the route decides it: no daemon heartbeat (lastSeenAt) for 5 min.
  const lastSeenAt = dev?.lastSeenAt ?? served?.device?.lastSeenAt ?? null;
  const offline = remote && (dev ? isDeviceStale(dev, now) : served?.device?.offline === true);
  const master = remote && dev?.master ? masterFromDevice(dev.master, now, board.settings?.briefing) : served;
  const l = offline
    ? { text: 'device offline', dot: 'bg-slate-500', cls: 'border-slate-700 text-slate-400' }
    : masterLabel(master);
  const published = remote && typeof dev?.master?.publishedAt === 'string' ? dev.master.publishedAt : null;
  const pid = remote && typeof dev?.master?.pid === 'number' ? dev.master.pid : null;
  const lines = [
    `Master on ${name}` + (offline ? `: ${name} was last seen ${agoText(lastSeenAt, now)}` : ''),
    masterTitle(master),
  ];
  if (pid) lines.push(`pid ${pid}`);
  if (published) lines.push(`status published ${agoText(published, now)}`);
  const title = remote ? lines.join('\n') : masterTitle(master);
  return (
    <span className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] ${l.cls}`} title={title}>
      <span className={`h-2 w-2 rounded-full ${l.dot}`} aria-hidden="true" />
      master · {l.text}
      {remote && <span className="text-slate-500">on {name}</span>}
    </span>
  );
}

/** Firestore offline mode: shown only while the store can't be reached or
 * writes are waiting to sync (the daemon syncs them; see lib/outbox.ts). */
function StoreChip() {
  const { board } = useShared();
  const st = board.storeStatus;
  if (!st || (st.online && st.pending === 0)) return null;
  const waiting = st.pending ? `${st.pending} change${st.pending === 1 ? '' : 's'} waiting to sync` : '';
  const text = st.online ? `syncing · ${waiting}` : ['offline', waiting].filter(Boolean).join(' · ');
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-amber-900 px-2.5 py-1.5 text-xs text-amber-300"
      title={
        st.online
          ? 'Back online: the daemon is syncing the changes made while offline.'
          : 'Firestore is unreachable: showing the last known state. Changes are kept on this Mac and synced once back online.'
      }
    >
      <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * Versioning (README "Versioning"): a line per device behind the store's
 * release, by name, on every board; red when this board is read-only (behind on
 * the data format). Nothing while all are up to date.
 */
function VersionBanner() {
  const { board, version } = useShared();
  const notices = versionNotices({ devices: board.devices, settings: board.settings, self: board.self, local: version });
  if (notices.length === 0) return null;
  return (
    <div role="status" className="border-b border-slate-800 text-xs">
      {notices.map((n) => (
        <p
          key={n.key}
          className={`px-6 py-1.5 ${n.tone === 'red' ? 'bg-[#2a0d12] text-red-200' : 'bg-[#2a1d0a] text-amber-200'}`}
        >
          {n.text}
        </p>
      ))}
    </div>
  );
}

/** "dev build" beside this device's chip: a clone off main or with uncommitted changes. */
function DevBuildChip() {
  const { version } = useShared();
  if (!version?.dev) return null;
  return (
    <span
      className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400"
      title={`ks-flow ${version.version} is a dev build (${version.devReason ?? 'not a release'}): it never raises the store's version and never updates itself`}
    >
      dev build
    </span>
  );
}

export function AppHeader({ toolbar }: { toolbar?: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const { config, board, notesEnabled, bellCount, inboxCount, version, boardVersion, ksVersion, errorCount } = useShared();
  // The board's own version; amber when its daemon runs another one (the board
  // wasn't rebuilt: `ks-flow open` does it).
  const daemonVersion = version?.version ?? null;
  const boardStale = !!boardVersion && !!daemonVersion && boardVersion !== daemonVersion;
  // This device's record: its project path and its own (localhost) Inbox.
  const me = board.devices.find((d) => d.deviceId === board.self);
  const projectPath = me?.projectPath ?? config.projectPath;
  const inboxUrl = me?.inboxUrl ?? null;
  const inboxRunning = me?.inboxRunning ?? false;
  const hot = bellCount > 0;

  const iconLink = (href: string, label: string, icon: ReactNode) => (
    <Link
      href={href}
      aria-label={label}
      title={label}
      aria-current={isActive(pathname, href) ? 'page' : undefined}
      className={`rounded-md p-1.5 hover:bg-slate-800 hover:text-slate-200 ${
        isActive(pathname, href) ? 'bg-indigo-950 text-indigo-200' : 'text-slate-400'
      }`}
    >
      {icon}
    </Link>
  );

  const inboxInner = (
    <>
      <InboxIcon />
      Inbox
      {inboxCount > 0 && (
        <span className="rounded-full bg-slate-700 px-[7px] text-xs text-slate-100">{inboxCount}</span>
      )}
    </>
  );
  const inboxCls =
    'flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-[13px] text-slate-300';

  return (
    <div className="sticky top-0 z-20">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-slate-800 bg-[#0b1222] px-6 py-3 text-sm">
        <div className="flex items-baseline gap-2.5">
          <Link href="/" className="text-[15px] font-bold text-slate-100 hover:text-white">
            ks-flow
          </Link>
          {boardVersion && (
            <span
              className={`font-mono text-[11px] ${boardStale ? 'text-amber-400' : 'text-slate-500'}`}
              title={
                boardStale
                  ? `This board was built from ks-flow ${boardVersion}; the daemon runs ${daemonVersion}. ks-flow open rebuilds it.`
                  : `Board: ks-flow ${boardVersion}${daemonVersion ? ` · daemon ${daemonVersion}` : ''}`
              }
            >
              v{boardVersion}
            </span>
          )}
          {ksVersion && (
            <span
              className="font-mono text-[11px] text-slate-500"
              title={`The ks plugin on this Mac (commands, launchers, rules, status line): ${ksVersion}`}
            >
              · ks {ksVersion}
            </span>
          )}
          {projectPath && (
            <span className="font-mono text-xs text-slate-400" title={projectPath}>
              {basename(projectPath)}
            </span>
          )}
        </div>
        <nav aria-label="Pages" className="flex flex-wrap gap-1">
          {TABS.filter((t) => !t.notesOnly || notesEnabled || pathname === t.href).map((t) => {
            const active = isActive(pathname, t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 ${
                  active
                    ? 'bg-indigo-950 font-semibold text-indigo-200'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="grow" />
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/briefing"
            aria-label={`Briefing: ${bellCount} hot or overdue`}
            title={hot ? `${bellCount} briefing item${bellCount === 1 ? '' : 's'} hot or overdue` : 'Nothing hot or overdue'}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 ${
              hot
                ? 'border-red-900 bg-[#2a0d12] text-red-200 hover:bg-red-950'
                : 'border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <BellIcon />
            <span className="font-bold">{bellCount}</span>
          </Link>
          {inboxUrl ? (
            <a
              href={inboxUrl}
              target="_blank"
              rel="noreferrer"
              className={`${inboxCls} hover:bg-slate-800`}
              title={
                (inboxCount ? `${inboxCount} waiting on you across the cards` : 'Plannotator Inbox') +
                (inboxRunning ? '' : ' — the Inbox is closed: run `plannotator inbox`')
              }
            >
              {inboxInner}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className={`${inboxCls} cursor-not-allowed opacity-60`}
              title="The Plannotator Inbox isn't running: run `plannotator inbox`"
            >
              {inboxInner}
            </button>
          )}
          <StoreChip />
          <DeviceChip deviceId={board.self} prefix="this device: " className="!max-w-[16rem] !px-2 !py-1 !text-xs" />
          <DevBuildChip />
          <MasterChip />
          <Link
            href="/errors"
            aria-label={errorCount ? `${errorCount} ks-flow problem${errorCount === 1 ? '' : 's'} on this device` : 'No ks-flow problems on this device'}
            title={errorCount ? `${errorCount} ks-flow problem${errorCount === 1 ? '' : 's'} on this device — see the Errors page` : 'No ks-flow problems on this device'}
            aria-current={isActive(pathname, '/errors') ? 'page' : undefined}
            className={`flex items-center gap-1 rounded-md p-1.5 ${
              errorCount
                ? 'border border-red-900 bg-[#2a0d12] px-2 text-red-200 hover:bg-red-950'
                : isActive(pathname, '/errors')
                  ? 'bg-indigo-950 text-indigo-200'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <WarningIcon />
            {errorCount > 0 && <span className="text-xs font-bold">{errorCount}</span>}
          </Link>
          {iconLink('/processes', 'Running processes on this device', <ProcessesIcon />)}
          {iconLink('/settings', 'Settings', <GearIcon />)}
        </div>
      </header>
      <VersionBanner />
      {toolbar && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-6 py-1.5 text-xs backdrop-blur">
          {toolbar}
        </div>
      )}
    </div>
  );
}
