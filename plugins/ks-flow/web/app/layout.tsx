import type { Metadata } from 'next';
import './globals.css';
import { loadBoardConfig } from '@/lib/boardConfig';
import { Providers } from './providers';

// The config (project.conf, provider env) is read per request, never baked at build.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ks-flow',
  description: 'Per-project Kanban board over your Claude Code sessions',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = loadBoardConfig();
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100">
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
