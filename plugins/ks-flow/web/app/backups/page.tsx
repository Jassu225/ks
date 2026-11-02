// /backups — the old Backups page, now the Activity Log's Backup filter. Kept as
// a redirect so bookmarks and older links still land somewhere.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function Page() {
  redirect('/activity?type=backup');
}
