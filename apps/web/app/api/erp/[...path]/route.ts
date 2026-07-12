import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { refreshAccessToken } from '@/lib/oidc';
import { decryptSession, encryptSession, secureCookieOptions, SESSION_COOKIE, type SessionPayload } from '@/lib/session';
import { getWebConfig } from '@/lib/server-env';

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  if (request.method !== 'GET' && !validMutationOrigin(request)) {
    return NextResponse.json({ code: 'INVALID_ORIGIN', message: 'Request origin is not allowed' }, { status: 403 });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declaredLength) || declaredLength > 2_097_152) {
    return NextResponse.json({ code: 'REQUEST_TOO_LARGE' }, { status: 413 });
  }
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  let session = cookie === undefined ? null : await decryptSession(cookie);
  if (session === null) return NextResponse.json({ code: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
  let sessionChanged = false;
  if (session.accessExpiresAt <= Date.now() + 30_000) {
    if (session.refreshToken === undefined) return NextResponse.json({ code: 'SESSION_EXPIRED' }, { status: 401 });
    try {
      const refreshed = await refreshAccessToken(session.refreshToken);
      session = { ...refreshed };
      sessionChanged = true;
    } catch {
      return NextResponse.json({ code: 'SESSION_EXPIRED' }, { status: 401 });
    }
  }
  const { path } = await context.params;
  if (path.length === 0 || path.some((segment) => !/^[a-zA-Z0-9._~-]+$/.test(segment))) {
    return NextResponse.json({ code: 'INVALID_API_PATH' }, { status: 400 });
  }
  const target = new URL(`${getWebConfig().NIET_API_BASE_URL.replace(/\/$/, '')}/${path.join('/')}`);
  target.search = request.nextUrl.search;
  const requestBody = request.method === 'GET' || request.method === 'HEAD'
    ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method,
    headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json',
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-correlation-id': request.headers.get('x-correlation-id') ?? randomUUID() },
    ...(requestBody === undefined ? {} : { body: requestBody }),
    cache: 'no-store', redirect: 'manual' });
  const response = new NextResponse(upstream.body, { status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
      'x-correlation-id': upstream.headers.get('x-correlation-id') ?? '' } });
  if (sessionChanged) await setSession(response, session);
  return response;
}

function validMutationOrigin(request: NextRequest): boolean {
  return request.headers.get('origin') === new URL(getWebConfig().WEB_ORIGIN).origin
    && request.headers.get('x-requested-with') === 'niet-erp-web';
}

async function setSession(response: NextResponse, session: SessionPayload): Promise<void> {
  response.cookies.set(SESSION_COOKIE, await encryptSession(session), { ...secureCookieOptions, maxAge: 28_800 });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
