import { Pool } from 'pg';
import { Client } from '@opensearch-project/opensearch';
import { parseWorkerConfig } from './config';
import { OutboxPublisherService, sanitizeOperationalError } from './outbox/outbox-publisher.service';
import { RabbitEventPublisher } from './outbox/rabbit-event.publisher';
import { SearchProjectionService } from './search/search-projection.service';
import { WaitlistExpiryService } from './registration/waitlist-expiry.service';

async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const pool = new Pool({ connectionString: config.DATABASE_URL,
    application_name: `niet-erp-outbox-${config.WORKER_ID}`, max: 4 });
  if (config.OUTBOX_PUBLISHER_ENABLED && config.AMQP_URL === undefined) {
    throw new Error('Outbox publisher AMQP URL is missing');
  }
  const eventPublisher = config.OUTBOX_PUBLISHER_ENABLED && config.AMQP_URL !== undefined
    ? new RabbitEventPublisher(config.AMQP_URL, config.OUTBOX_EXCHANGE) : undefined;
  const outbox = eventPublisher === undefined ? undefined
    : new OutboxPublisherService(pool, eventPublisher, config.OUTBOX_MAX_ATTEMPTS);
  let searchProjection: SearchProjectionService | undefined;
  if (config.SEARCH_PROJECTION_ENABLED) {
    if (config.OPENSEARCH_NODE === undefined || config.OPENSEARCH_USERNAME === undefined
      || config.OPENSEARCH_PASSWORD === undefined) {
      throw new Error('Search projection credentials are missing');
    }
    const searchClient = new Client({ node: config.OPENSEARCH_NODE,
      auth: { username: config.OPENSEARCH_USERNAME, password: config.OPENSEARCH_PASSWORD } });
    searchProjection = new SearchProjectionService(pool, searchClient,
      config.OPENSEARCH_INDEX, config.SEARCH_MAX_ATTEMPTS);
  }
  let stopping = false;
  const waitlistExpiry = config.WAITLIST_EXPIRY_PROCESSOR_ENABLED
    ? new WaitlistExpiryService(pool, config.WORKER_ID) : undefined;

  const stop = (): void => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopping) {
      let processed = false;
      try {
        processed = outbox === undefined ? false : await outbox.processOne();
        const indexed = searchProjection === undefined ? false : await searchProjection.processOne();
        const expired = waitlistExpiry === undefined ? false : await waitlistExpiry.processOne();
        processed = processed || indexed || expired;
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: 'error', event: 'outbox_iteration_failed',
          message: sanitizeOperationalError(error) })}\n`);
      }
      if (!processed) await delay(config.OUTBOX_POLL_INTERVAL_MS);
    }
  } finally {
    if (eventPublisher !== undefined) await eventPublisher.close();
    await pool.end();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main();
