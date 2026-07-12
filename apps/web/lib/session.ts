import 'server-only';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { getWebConfig } from './server-env';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production'
  ? '__Host-niet_erp_session' : 'niet_erp_session';
export const TRANSACTION_COOKIE = process.env.NODE_ENV === 'production'
  ? '__Host-niet_erp_oidc' : 'niet_erp_oidc';

export interface SessionPayload {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt: number;
}

export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
}

function encryptionKey(): Uint8Array {
  const key = Buffer.from(getWebConfig().SESSION_ENCRYPTION_KEY, 'base64url');
  if (key.byteLength !== 32) throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

async function encrypt(payload: Record<string, unknown>, expiresIn: string): Promise<string> {
  return new EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt().setExpirationTime(expiresIn).encrypt(encryptionKey());
}

async function decrypt<T>(value: string): Promise<T | null> {
  try {
    const result = await jwtDecrypt(value, encryptionKey(), { keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'] });
    return result.payload as T;
  } catch {
    return null;
  }
}

export function encryptSession(payload: SessionPayload): Promise<string> {
  return encrypt({ ...payload }, '8h');
}

export function decryptSession(value: string): Promise<SessionPayload | null> {
  return decrypt<SessionPayload>(value);
}

export function encryptTransaction(payload: OidcTransaction): Promise<string> {
  return encrypt({ ...payload }, '10m');
}

export function decryptTransaction(value: string): Promise<OidcTransaction | null> {
  return decrypt<OidcTransaction>(value);
}

export const secureCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
