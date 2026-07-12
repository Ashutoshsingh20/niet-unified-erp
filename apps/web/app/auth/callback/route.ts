import { NextResponse, type NextRequest } from 'next/server';
import { exchangeAuthorizationCode } from '@/lib/oidc';
import {
  decryptTransaction,
  encryptSession,
  secureCookieOptions,
  SESSION_COOKIE,
  TRANSACTION_COOKIE,
} from '@/lib/session';
import { getWebConfig } from '@/lib/server-env';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const transactionCookie = request.cookies.get(TRANSACTION_COOKIE)?.value;
  const transaction = transactionCookie === undefined ? null : await decryptTransaction(transactionCookie);
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (transaction === null || code === null || state !== transaction.state
    || request.nextUrl.searchParams.has('error')) {
    return NextResponse.redirect(new URL('/sign-in?error=authentication_failed', getWebConfig().WEB_ORIGIN));
  }
  try {
    const token = await exchangeAuthorizationCode({ code, verifier: transaction.verifier,
      nonce: transaction.nonce });
    const session = await encryptSession({ accessToken: token.access_token,
      ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
      accessExpiresAt: Date.now() + token.expires_in * 1000 });
    const response = NextResponse.redirect(new URL(transaction.returnTo, getWebConfig().WEB_ORIGIN));
    response.cookies.set(SESSION_COOKIE, session, { ...secureCookieOptions, maxAge: 28_800 });
    response.cookies.delete({ name: TRANSACTION_COOKIE, path: '/auth' });
    return response;
  } catch {
    return NextResponse.redirect(new URL('/sign-in?error=authentication_failed', getWebConfig().WEB_ORIGIN));
  }
}

