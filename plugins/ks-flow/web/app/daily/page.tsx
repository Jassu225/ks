// /daily — the daily log (screens: "Log-off review"): what /ks-master:log-in
// and log-off wrote to daily_logs, plus that day's item activity.
// ?date=YYYY-MM-DD opens that day.
import { Suspense } from 'react';
import { DailyLogPage } from '@/components/briefing/DailyLogPage';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense>
      <DailyLogPage />
    </Suspense>
  );
}
