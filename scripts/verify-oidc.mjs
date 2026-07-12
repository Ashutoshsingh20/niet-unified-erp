import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TokenVerifierService } from '../apps/api/dist/platform/auth/token-verifier.service.js';

const issuer = 'https://identity.niet.test/realms/niet';
const audience = 'niet-erp-api';
const keys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'verification-key', use: 'sig', alg: 'RS256' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('JWKS verifier did not bind');
const values = { OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience,
  OIDC_JWKS_URI: `http://127.0.0.1:${address.port}/jwks` };
const verifier = new TokenVerifierService({ get: (key) => values[key] });

async function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ sub: 'staff-123', sid: 'session-456', acr: '2', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'verification-key' }).setIssuedAt(now);
  if (!Object.hasOwn(overrides, 'iss')) builder = builder.setIssuer(issuer);
  if (!Object.hasOwn(overrides, 'aud')) builder = builder.setAudience(audience);
  if (!Object.hasOwn(overrides, 'exp')) builder = builder.setExpirationTime(now + 300);
  return builder.sign(keys.privateKey);
}

async function mustReject(value, name) {
  try {
    await verifier.verify(value);
  } catch {
    return;
  }
  throw new Error(`${name} was accepted`);
}

try {
  const identity = await verifier.verify(await token());
  if (identity.subjectId !== 'staff-123' || identity.sessionId !== 'session-456'
    || identity.assuranceLevel !== 2) throw new Error('Valid identity claims were not mapped');
  await mustReject(await token({ iss: 'https://attacker.invalid' }), 'wrong issuer');
  await mustReject(await token({ aud: 'another-api' }), 'wrong audience');
  await mustReject(await token({ exp: Math.floor(Date.now() / 1000) - 10 }), 'expired token');
  await mustReject(await token({ sub: undefined }), 'subjectless token');
  await mustReject('not-a-jwt', 'malformed bearer material');
  process.stdout.write('OIDC signature, issuer, audience, expiry, subject, and assurance mapping verified\n');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
