'use client';
// app/providers.tsx — client-side context shared by every page. The root layout
// renders it, so what it holds (the action streams and their panels) survives a
// move between pages: a backup started on the board keeps streaming on /backups.
import { StreamPanelProvider } from '@/components/StreamPanel';

export function Providers({ children }: { children: React.ReactNode }) {
  return <StreamPanelProvider>{children}</StreamPanelProvider>;
}
