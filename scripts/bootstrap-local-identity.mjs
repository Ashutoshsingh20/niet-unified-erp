const keycloakBaseUrl = parseLoopbackUrl(
  process.env.KEYCLOAK_BASE_URL ?? 'http://127.0.0.1:8080',
  'KEYCLOAK_BASE_URL',
);
const webOrigin = parseLoopbackUrl(
  process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000',
  'WEB_ORIGIN',
);
const realmName = process.env.OIDC_REALM ?? 'niet';
const adminUsername = required('KEYCLOAK_ADMIN_USERNAME');
const adminPassword = required('KEYCLOAK_ADMIN_PASSWORD');
const webClientSecret = required('OIDC_CLIENT_SECRET');
const registrationAllowed = (process.env.OIDC_SELF_REGISTRATION_ENABLED ?? 'true') === 'true';

if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(realmName)) {
  throw new Error('OIDC_REALM must be a valid Keycloak realm name');
}
if (webClientSecret.length < 16) throw new Error('OIDC_CLIENT_SECRET must contain at least 16 characters');
if (process.env.NODE_ENV === 'production') {
  throw new Error('Local identity bootstrap refuses to run with NODE_ENV=production');
}

const tokenResponse = await request('/realms/master/protocol/openid-connect/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: 'admin-cli',
    grant_type: 'password',
    username: adminUsername,
    password: adminPassword,
  }),
}, false);
if (typeof tokenResponse?.access_token !== 'string' || tokenResponse.access_token.length === 0) {
  throw new Error('Keycloak admin token response was invalid');
}
const adminToken = tokenResponse.access_token;
const adminPath = `/admin/realms/${encodeURIComponent(realmName)}`;

const realmResponse = await fetchResponse(adminPath, { method: 'GET' });
if (realmResponse.status === 404) {
  await request('/admin/realms', {
    method: 'POST',
    body: JSON.stringify({
      ...realmSettings(),
      clients: [apiClient(), webClient()],
    }),
  });
} else {
  const currentRealm = await parseResponse(realmResponse, adminPath);
  await request(adminPath, {
    method: 'PUT',
    body: JSON.stringify({ ...currentRealm, ...realmSettings() }),
  });
  await ensureClient(apiClient());
  await ensureClient(webClient());
}

const webClientId = await findClientId('niet-erp-web');
await ensureAudienceMapper(webClientId);

const discovery = await request(
  `/realms/${encodeURIComponent(realmName)}/.well-known/openid-configuration`,
  { method: 'GET' },
  false,
);
const expectedIssuer = `${keycloakBaseUrl.origin}/realms/${realmName}`;
if (discovery?.issuer !== expectedIssuer) {
  throw new Error(`Keycloak discovery issuer mismatch: expected ${expectedIssuer}`);
}

process.stdout.write(
  `Local Keycloak realm '${realmName}' is ready; self-registration is ${registrationAllowed ? 'enabled' : 'disabled'}\n`,
);

function realmSettings() {
  return {
    realm: realmName,
    enabled: true,
    displayName: 'NIET Unified ERP Local Review',
    registrationAllowed,
    registrationEmailAsUsername: false,
    rememberMe: true,
    resetPasswordAllowed: false,
    verifyEmail: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    bruteForceProtected: true,
    sslRequired: 'external',
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1_800,
    ssoSessionMaxLifespan: 28_800,
    passwordPolicy: 'length(8) and upperCase(1) and lowerCase(1) and digits(1)',
  };
}

function apiClient() {
  return {
    clientId: 'niet-erp-api',
    name: 'NIET ERP API audience',
    enabled: true,
    bearerOnly: true,
    publicClient: false,
    protocol: 'openid-connect',
  };
}

function webClient() {
  return {
    clientId: 'niet-erp-web',
    name: 'NIET ERP local review BFF',
    enabled: true,
    clientAuthenticatorType: 'client-secret',
    secret: webClientSecret,
    publicClient: false,
    bearerOnly: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: true,
    protocol: 'openid-connect',
    redirectUris: [`${webOrigin.origin}/auth/callback`],
    webOrigins: [webOrigin.origin],
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': `${webOrigin.origin}/sign-in`,
    },
  };
}

async function ensureClient(desired) {
  const matches = await findClients(desired.clientId);
  if (matches.length === 0) {
    await request(`${adminPath}/clients`, { method: 'POST', body: JSON.stringify(desired) });
    return;
  }
  if (matches.length !== 1 || typeof matches[0]?.id !== 'string') {
    throw new Error(`Expected exactly one Keycloak client named ${desired.clientId}`);
  }
  const clientPath = `${adminPath}/clients/${encodeURIComponent(matches[0].id)}`;
  const current = await request(clientPath, { method: 'GET' });
  await request(clientPath, {
    method: 'PUT',
    body: JSON.stringify({ ...current, ...desired }),
  });
}

async function findClientId(clientId) {
  const matches = await findClients(clientId);
  if (matches.length !== 1 || typeof matches[0]?.id !== 'string') {
    throw new Error(`Expected exactly one Keycloak client named ${clientId}`);
  }
  return matches[0].id;
}

async function findClients(clientId) {
  const result = await request(
    `${adminPath}/clients?clientId=${encodeURIComponent(clientId)}`,
    { method: 'GET' },
  );
  if (!Array.isArray(result)) throw new Error('Keycloak client search response was invalid');
  return result.filter((candidate) => candidate?.clientId === clientId);
}

async function ensureAudienceMapper(clientId) {
  const mapperPath = `${adminPath}/clients/${encodeURIComponent(clientId)}/protocol-mappers/models`;
  const mappers = await request(mapperPath, { method: 'GET' });
  if (!Array.isArray(mappers)) throw new Error('Keycloak protocol mapper response was invalid');
  const desired = {
    name: 'niet-api-audience',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    consentRequired: false,
    config: {
      'included.client.audience': 'niet-erp-api',
      'id.token.claim': 'false',
      'access.token.claim': 'true',
    },
  };
  const existing = mappers.filter((mapper) => mapper?.name === desired.name);
  if (existing.length === 0) {
    await request(mapperPath, { method: 'POST', body: JSON.stringify(desired) });
    return;
  }
  if (existing.length !== 1 || typeof existing[0]?.id !== 'string') {
    throw new Error(`Expected exactly one ${desired.name} protocol mapper`);
  }
  await request(`${mapperPath}/${encodeURIComponent(existing[0].id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...existing[0], ...desired }),
  });
}

async function request(path, options, authenticated = true) {
  const response = await fetchResponse(path, options, authenticated);
  return parseResponse(response, path);
}

async function fetchResponse(path, options, authenticated = true) {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (authenticated) headers.set('authorization', `Bearer ${adminToken}`);
  return fetch(new URL(path, keycloakBaseUrl), {
    ...options,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

async function parseResponse(response, path) {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).replaceAll(/\s+/g, ' ');
    throw new Error(`Keycloak request ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;
  const text = await response.text();
  return text.length === 0 ? undefined : JSON.parse(text);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseLoopbackUrl(value, name) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${name} must use an HTTP(S) loopback origin`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  return parsed;
}
