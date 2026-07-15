import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createPkce, discoverOidc, randomOpaqueValue } from './oidc';
import { safeReturnTo } from './return-to';
import { encryptTransaction, secureCookieOptions, TRANSACTION_COOKIE } from './session';
import { getWebConfig } from './server-env';

export async function beginAuthorization(request: NextRequest,
  options: { readonly prompt?: 'create' } = {}): Promise<NextResponse> {
  const config = getWebConfig();
  const discovery = await discoverOidc();
  const state = randomOpaqueValue();
  const nonce = randomOpaqueValue();
  const pkce = createPkce();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const transaction = await encryptTransaction({ state, nonce, verifier: pkce.verifier, returnTo });
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.search = new URLSearchParams({ client_id: config.OIDC_CLIENT_ID,
    redirect_uri: config.OIDC_REDIRECT_URI, response_type: 'code', scope: 'openid profile',
    state, nonce, code_challenge: pkce.challenge, code_challenge_method: 'S256',
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(request.nextUrl.searchParams.get('stepUp') === 'true'
      ? { acr_values: '2', prompt: 'login' } : {}) }).toString();
  const response = NextResponse.redirect(authorization);
  response.cookies.set(TRANSACTION_COOKIE, transaction,
    { ...secureCookieOptions, path: '/auth', maxAge: 600 });
  return response;
}

export function identityUnavailable(request: NextRequest, error: unknown): NextResponse {
  console.error('OIDC authorization initiation failed', {
    error: error instanceof Error ? error.message : 'unknown error',
  });
  return NextResponse.redirect(new URL('/sign-in?error=identity_unavailable', request.url), 303);
}
