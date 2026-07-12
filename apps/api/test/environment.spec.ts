import { validateEnvironment } from '../src/config/environment';

describe('validateEnvironment', () => {
  it('provides safe development defaults', () => {
    expect(validateEnvironment({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      DATABASE_URL: 'postgresql://niet_erp:niet_erp_dev@127.0.0.1:5432/niet_erp',
      OIDC_ISSUER: 'http://127.0.0.1:8080/realms/niet',
      OIDC_AUDIENCE: 'niet-erp-api',
      OIDC_JWKS_URI: 'http://127.0.0.1:8080/realms/niet/protocol/openid-connect/certs',
    });
  });

  it('rejects an invalid port', () => {
    expect(() => validateEnvironment({ PORT: '70000' })).toThrow(
      'Invalid environment configuration',
    );
  });
});
