'use client';
// app/providers.tsx — client-side context shared by every page. The root layout
// renders it, so what it holds survives a move between pages: the action
// streams and their panels (a backup started on the board keeps streaming on
// /activity), and the one live store subscription (board + briefing + activity + master)
// that the shared header and the pages read.
import { StreamPanelProvider } from '@/components/StreamPanel';
import { BoardDataProvider } from '@/lib/boardData';
import type { BoardConfig } from '@/lib/types';

export function Providers({ config, children }: { config: BoardConfig; children: React.ReactNode }) {
  return (
    <StreamPanelProvider>
      <BoardDataProvider config={config}>{children}</BoardDataProvider>
    </StreamPanelProvider>
  );
}
