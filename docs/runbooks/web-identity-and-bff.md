# Web identity and BFF runbook

## Boundary

The browser never stores OAuth access or refresh tokens in local storage, session storage, IndexedDB, JavaScript-readable cookies, or page state. The Next.js backend-for-frontend (BFF) performs the authorization-code flow with PKCE and nonce validation, then stores tokens in an encrypted, authenticated, HTTP-only cookie.

Keycloak authenticates the user. The NestJS API remains authoritative for capability and resource-scope authorization.

## Required configuration

- `NIET_API_BASE_URL`: internal API base ending in `/api`; not internet-facing.
- `WEB_ORIGIN`: exact public origin of the on-premise web ERP.
- `OIDC_ISSUER`: exact Keycloak realm issuer.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: confidential BFF client.
- `OIDC_REDIRECT_URI`: registered callback under the web origin.
- `OIDC_SELF_REGISTRATION_ENABLED`: defaults to `false`; exposes the application-initiated
  registration action only after the identity owner approves self-registration for that realm.
- `SESSION_ENCRYPTION_KEY`: 32 cryptographically random bytes encoded as base64url.

Secrets must come from NIET's on-premise secret store. Never place production values in environment examples, images, logs, CI variables visible to untrusted jobs, or source control.

## Keycloak client requirements

- Authorization code flow only; implicit and password grants disabled.
- Exact redirect URI and web origin allowlists; no wildcard production redirect.
- PKCE S256 required.
- Short access-token lifetime and controlled refresh-token rotation.
- MFA/passkey authentication policy and an assurance claim compatible with the API's step-up level.
- Back-channel and front-channel logout policy must be confirmed during the Keycloak integration test.

## Account registration

The ERP does not collect or store passwords. When `OIDC_SELF_REGISTRATION_ENABLED=true`, the
sign-in page starts the same OIDC authorization-code flow with the standards-based
`prompt=create` parameter. Keycloak must separately have **User Registration** enabled. If either
side is disabled, the ERP fails closed and directs the user to NIET IT provisioning.

Self-registration creates an identity only. It never assigns ERP roles, scopes, student records,
or staff permissions. Those remain explicit, audited access-governance and admission-conversion
operations. Production activation requires D-01/D-02 identity and access-owner approval.

## BFF controls

- State, nonce, PKCE verifier, and return path are encrypted in a ten-minute transaction cookie.
- The ID token signature, issuer, audience, expiry, and nonce are verified.
- Session cookies use `Secure`, `HttpOnly`, `SameSite=Lax`, and the `__Host-` prefix in production.
- Mutating API proxy requests require the configured origin and `x-requested-with: niet-erp-web`.
- API path segments are allowlisted, request bodies are capped at 2 MiB, redirects are not followed, and responses are never cached.
- The API re-checks permission and scope on every request. Hidden buttons are not authorization.
- Logout rejects foreign origins and expires the session cookie.

## Content security

`proxy.ts` generates a per-request nonce and a restrictive Content Security Policy with `strict-dynamic`, no objects, no frames, same-origin connections, and no production `unsafe-eval`. Security headers also deny framing, MIME sniffing, referrer leakage, and unnecessary browser capabilities.

## Step-up actions

Approval decisions link to a Keycloak re-authentication request using assurance level 2. The API independently rejects an insufficient assurance claim. NIET must map the requested ACR to its approved MFA/passkey policy before production.

## Official logo asset

`apps/web/public/niet-logo.png` is the exact PNG published on NIET's official logo page at `https://www.niet.co.in/about/logo`. It is not redrawn, recolored, cropped, or resampled; Next.js may negotiate runtime delivery size without changing the repository source asset. NIET must confirm internal product usage rights and provide the production vector asset plus final color token before release.

## Verification

- `npm run verify` covers strict typing, lint, automated shell accessibility, tests, and production builds.
- The sign-in page must be loaded through the on-premise reverse proxy with its final TLS hostname.
- Integration testing requires a dedicated Keycloak realm/client and test identities for ordinary, scoped approver, step-up, revoked, delegated, and separated-user cases.
- Verify refresh rotation, concurrent refresh, logout, revoked sessions, key rotation, invalid state/nonce, callback errors, foreign origins, CSP violations, and 2 MiB body enforcement.
