import { Pool } from 'pg';
import { parseWorkerConfig } from './config';
import { OutboxPublisherService, sanitizeOperationalError } from './outbox/outbox-publisher.service';
import { RabbitEventPublisher } from './outbox/rabbit-event.publisher';

async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const pool = new Pool({ connectionString: config.DATABASE_URL,
    application_name: `niet-erp-outbox-${config.WORKER_ID}`, max: 4 });
  const eventPublisher = new RabbitEventPublisher(config.AMQP_URL, config.OUTBOX_EXCHANGE);
  const outbox = new OutboxPublisherService(pool, eventPublisher, config.OUTBOX_MAX_ATTEMPTS);
  let stopping = false;

  const stop = (): void => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopping) {
      let processed = false;
      try {
        processed = await outbox.processOne();
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: 'error', event: 'outbox_iteration_failed',
          message: sanitizeOperationalError(error) })}\n`);
      }
      if (!processed) await delay(config.OUTBOX_POLL_INTERVAL_MS);
    }
  } finally {
    await eventPublisher.close();
    await pool.end();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main();
