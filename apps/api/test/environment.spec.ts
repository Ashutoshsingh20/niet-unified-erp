import { validateEnvironment } from '../src/config/environment';

describe('validateEnvironment', () => {
  it('provides safe development defaults', () => {
    expect(validateEnvironment({
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORAGE_ACCESS_KEY: 'test-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'test-secret-key-value',
      OBJECT_STORAGE_QUARANTINE_BUCKET: 'test-quarantine',
      OBJECT_STORAGE_CLEAN_BUCKET: 'test-clean',
      OPENSEARCH_NODE: 'https://127.0.0.1:9200',
      OPENSEARCH_USERNAME: 'test-search-user',
      OPENSEARCH_PASSWORD: 'test-search-password',
    })).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      DATABASE_URL: 'postgresql://niet_erp:niet_erp_dev@127.0.0.1:5432/niet_erp',
      OIDC_ISSUER: 'http://127.0.0.1:8080/realms/niet',
      OIDC_AUDIENCE: 'niet-erp-api',
      OIDC_JWKS_URI: 'http://127.0.0.1:8080/realms/niet/protocol/openid-connect/certs',
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORAGE_REGION: 'us-east-1',
      OBJECT_STORAGE_ACCESS_KEY: 'test-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'test-secret-key-value',
      OBJECT_STORAGE_QUARANTINE_BUCKET: 'test-quarantine',
      OBJECT_STORAGE_CLEAN_BUCKET: 'test-clean',
      OPENSEARCH_NODE: 'https://127.0.0.1:9200',
      OPENSEARCH_USERNAME: 'test-search-user',
      OPENSEARCH_PASSWORD: 'test-search-password',
      OPENSEARCH_INDEX: 'niet-erp-search-v1',
    });
  });

  it('rejects an invalid port', () => {
    expect(() => validateEnvironment({
      PORT: '70000',
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORAGE_ACCESS_KEY: 'test-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'test-secret-key-value',
      OBJECT_STORAGE_QUARANTINE_BUCKET: 'test-quarantine',
      OBJECT_STORAGE_CLEAN_BUCKET: 'test-clean',
      OPENSEARCH_NODE: 'https://127.0.0.1:9200',
      OPENSEARCH_USERNAME: 'test-search-user',
      OPENSEARCH_PASSWORD: 'test-search-password',
    })).toThrow(
      'Invalid environment configuration',
    );
  });
});
