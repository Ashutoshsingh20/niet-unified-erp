import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getWebConfig } from './server-env';

interface OidcDiscovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly end_session_endpoint?: string;
  readonly jwks_uri: string;
  readonly issuer: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly id_token: string;
  readonly expires_in: number;
}

let discoveryCache: { value: OidcDiscovery; expiresAt: number } | undefined;

export async function discoverOidc(): Promise<OidcDiscovery> {
  if (discoveryCache !== undefined && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  const issuer = getWebConfig().OIDC_ISSUER.replace(/\/$/, '');
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' }, cache: 'no-store',
  });
  if (!response.ok) throw new Error('NIET identity provider discovery failed');
  const value = await response.json() as OidcDiscovery;
  if (value.issuer !== issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
    throw new Error('NIET identity provider discovery response is invalid');
  }
  discoveryCache = { value, expiresAt: Date.now() + 3_600_000 };
  return value;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

export async function exchangeAuthorizationCode(input: {
  readonly code: string;
  readonly verifier: string;
  readonly nonce: string;
}): Promise<TokenResponse> {
  const config = getWebConfig();
  const discovery = await discoverOidc();
  const credentials = Buffer.from(`${config.OIDC_CLIENT_ID}:${config.OIDC_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code,
      redirect_uri: config.OIDC_REDIRECT_URI, code_verifier: input.verifier }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('NIET identity token exchange failed');
  const token = await response.json() as Partial<TokenResponse>;
  if (typeof token.access_token !== 'string' || typeof token.id_token !== 'string'
    || typeof token.expires_in !== 'number') throw new Error('NIET identity token response is invalid');
  const verified = await jwtVerify(token.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
    issuer: discovery.issuer, audience: config.OIDC_CLIENT_ID,
    algorithms: ['RS256', 'PS256', 'ES256'],
  });
  if (verified.payload.nonce !== input.nonce) throw new Error('NIET identity nonce validation failed');
  return { access_token: token.access_token, id_token: token.id_token,
    expires_in: token.expires_in,
    ...(typeof token.refresh_token === 'string' ? { refresh_token: token.refresh_token } : {}) };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string; refreshToken: string; accessExpiresAt: number;
}> {
  const config = getWebConfig();
  const discovery = await discoverOidc();
  const credentials = Buffer.from(`${config.OIDC_CLIENT_ID}:${config.OIDC_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(discovery.token_endpoint, { method: 'POST',
    headers: { authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    cache: 'no-store' });
  if (!response.ok) throw new Error('NIET identity session refresh failed');
  const token = await response.json() as Record<string, unknown>;
  if (typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
    throw new Error('NIET identity refresh response is invalid');
  }
  return { accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : refreshToken,
    accessExpiresAt: Date.now() + token.expires_in * 1000 };
}
