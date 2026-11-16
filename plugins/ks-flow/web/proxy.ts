// Refuses every request not from this Mac's own board pages (lib/localguard.ts).
import { NextResponse, type NextRequest } from 'next/server';
import { refuseReason } from './lib/localguard';

export function proxy(req: NextRequest): NextResponse {
  const why = refuseReason({
    method: req.method,
    pathname: req.nextUrl.pathname,
    host: req.headers.get('host'),
    origin: req.headers.get('origin'),
    secFetchSite: req.headers.get('sec-fetch-site'),
  });
  if (why) return new NextResponse(`ks-flow board: refused (${why})\n`, { status: 403 });
  return NextResponse.next();
}
