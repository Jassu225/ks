// /activity — the Activity Log: every background run ks-flow and the master
// session record (backups, briefing passes, log-in / log-off, master starts,
// restarts and requests). The page is components/activity/ActivityPage.tsx.
import { Suspense } from 'react';
import { ActivityPage } from '@/components/activity/ActivityPage';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense>
      <ActivityPage />
    </Suspense>
  );
}
