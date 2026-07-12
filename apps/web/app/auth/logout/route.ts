import { NextResponse, type NextRequest } from 'next/server';
import { getWebConfig } from '@/lib/server-env';
import { secureCookieOptions, SESSION_COOKIE } from '@/lib/session';

export function POST(request: NextRequest): NextResponse {
  if (request.headers.get('origin') !== new URL(getWebConfig().WEB_ORIGIN).origin) {
    return NextResponse.json({ code: 'INVALID_ORIGIN' }, { status: 403 });
  }
  const response = NextResponse.redirect(new URL('/sign-in', getWebConfig().WEB_ORIGIN), 303);
  response.cookies.set(SESSION_COOKIE, '', { ...secureCookieOptions, maxAge: 0 });
  return response;
}
