// /briefing — what Slack asks of the person, escalating to its due time.
// Data comes from the layout's shared subscription (lib/boardData.tsx).
import { BriefingPage } from '@/components/briefing/BriefingPage';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <BriefingPage />;
}
