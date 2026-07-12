import { parseWorkerConfig } from '../src/config';

describe('parseWorkerConfig', () => {
  it('allows an outbox-only worker without OpenSearch credentials', () => {
    const config = parseWorkerConfig({ DATABASE_URL: 'postgresql://user:pass@localhost/db',
      AMQP_URL: 'amqp://user:pass@localhost', OUTBOX_PUBLISHER_ENABLED: 'true',
      SEARCH_PROJECTION_ENABLED: 'false' });
    expect(config.OUTBOX_PUBLISHER_ENABLED).toBe(true);
    expect(config.SEARCH_PROJECTION_ENABLED).toBe(false);
  });

  it('allows a search-only worker without AMQP credentials', () => {
    const config = parseWorkerConfig({ DATABASE_URL: 'postgresql://user:pass@localhost/db',
      OUTBOX_PUBLISHER_ENABLED: 'false', SEARCH_PROJECTION_ENABLED: 'true',
      OPENSEARCH_NODE: 'https://localhost:9200', OPENSEARCH_USERNAME: 'search-worker',
      OPENSEARCH_PASSWORD: 'verification-password' });
    expect(config.SEARCH_PROJECTION_ENABLED).toBe(true);
  });

  it('rejects a worker with no enabled role', () => {
    expect(() => parseWorkerConfig({ DATABASE_URL: 'postgresql://user:pass@localhost/db',
      OUTBOX_PUBLISHER_ENABLED: 'false', SEARCH_PROJECTION_ENABLED: 'false' })).toThrow(
      'At least one worker role must be enabled',
    );
  });
});
