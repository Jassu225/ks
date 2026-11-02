'use client';
// The header every page shares: ks-flow + project, the page tabs, then the
// bell (briefing items hot or overdue), the Inbox button, the master chip, and
// the Processes / Settings icons. A page's own controls go in `toolbar`, a
// slim second row under it (the board's swimlanes, refresh, backup, kill…).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useShared } from '@/lib/boardData';
import type { MasterStatus } from '@/lib/types';
import { BellIcon, GearIcon, InboxIcon, ProcessesIcon } from './icons';

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

export function MasterChip() {
  const { master } = useShared();
  const l = masterLabel(master);
  return (
    <span
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] ${l.cls}`}
      title={masterTitle(master)}
    >
      <span className={`h-2 w-2 rounded-full ${l.dot}`} aria-hidden="true" />
      master · {l.text}
    </span>
  );
}

export function AppHeader({ toolbar }: { toolbar?: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const { config, board, notesEnabled, bellCount, inboxCount } = useShared();
  const projectPath = board.project?.projectPath ?? config.projectPath;
  const inboxUrl = board.project?.inboxUrl ?? null;
  const inboxRunning = board.project?.inboxRunning ?? false;
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
          <MasterChip />
          {iconLink('/processes', 'Running processes', <ProcessesIcon />)}
          {iconLink('/settings', 'Settings', <GearIcon />)}
        </div>
      </header>
      {toolbar && (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-6 py-1.5 text-xs backdrop-blur">
          {toolbar}
        </div>
      )}
    </div>
  );
}
