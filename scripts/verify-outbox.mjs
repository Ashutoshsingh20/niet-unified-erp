import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import pg from 'pg';
import { OutboxPublisherService } from '../apps/worker/dist/outbox/outbox-publisher.service.js';
import { RabbitEventPublisher } from '../apps/worker/dist/outbox/rabbit-event.publisher.js';

const databaseUrl = process.env.DATABASE_URL;
const amqpUrl = process.env.AMQP_URL;
if (databaseUrl === undefined || amqpUrl === undefined) {
  throw new Error('DATABASE_URL and AMQP_URL are required');
}
const pool = new pg.Pool({ connectionString: databaseUrl, application_name: 'outbox-verifier' });
const database = await pool.query('SELECT current_database() AS name');
if (!String(database.rows[0]?.name ?? '').endsWith('_test')) {
  throw new Error('Outbox verification refuses to modify a database without a _test suffix');
}
await pool.query('DELETE FROM platform.outbox_events WHERE published_at IS NULL');

const exchange = `niet.erp.verification.${randomUUID()}`;
const connection = await connect(amqpUrl);
const channel = await connection.createChannel();
await channel.assertExchange(exchange, 'topic', { durable: true, autoDelete: false });
const queue = await channel.assertQueue('', { exclusive: true, autoDelete: true });
await channel.bindQueue(queue.queue, exchange, 'VerificationEvent');
const publisher = new RabbitEventPublisher(amqpUrl, exchange);
const service = new OutboxPublisherService(pool, publisher, 3);

try {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO platform.outbox_events
      (id, event_type, event_version, aggregate_type, aggregate_id, correlation_id,
       classification, payload)
     VALUES ($1, 'VerificationEvent', 1, 'verification', $2, 'verification-correlation',
             'INTERNAL', '{"verified":true}'::jsonb)`, [eventId, eventId]);
  if (!await service.processOne()) throw new Error('Outbox publisher did not claim the event');
  const message = await channel.get(queue.queue, { noAck: false });
  if (message === false) throw new Error('RabbitMQ did not receive the confirmed outbox event');
  const envelope = JSON.parse(message.content.toString('utf8'));
  if (envelope.eventId !== eventId || envelope.payload?.verified !== true
    || message.properties.deliveryMode !== 2 || message.properties.messageId !== eventId) {
    throw new Error('RabbitMQ event envelope or persistence metadata is invalid');
  }
  channel.ack(message);
  const published = await pool.query(
    'SELECT published_at, attempts FROM platform.outbox_events WHERE id = $1', [eventId]);
  if (published.rows[0]?.published_at === null || published.rows[0]?.attempts !== 0) {
    throw new Error('Confirmed event was not marked published');
  }

  const failedId = randomUUID();
  await pool.query(
    `INSERT INTO platform.outbox_events
      (id, event_type, event_version, aggregate_type, aggregate_id, correlation_id,
       classification, payload)
     VALUES ($1, 'VerificationFailure', 1, 'verification', $2, 'verification-correlation',
             'INTERNAL', '{}'::jsonb)`, [failedId, failedId]);
  const failingPublisher = {
    async publish() { throw new Error('Simulated broker failure\nwithout secret data'); },
    async close() {},
  };
  const failingService = new OutboxPublisherService(pool, failingPublisher, 3);
  await failingService.processOne();
  const failed = await pool.query(
    `SELECT attempts, last_error, next_attempt_at > clock_timestamp() AS delayed, failed_at
     FROM platform.outbox_events WHERE id = $1`, [failedId]);
  if (failed.rows[0]?.attempts !== 1 || failed.rows[0]?.delayed !== true
    || failed.rows[0]?.failed_at !== null || String(failed.rows[0]?.last_error).includes('\n')) {
    throw new Error('Failed publication retry state is invalid');
  }
  process.stdout.write('RabbitMQ publisher confirm, durable envelope, and outbox retry verified\n');
} finally {
  await publisher.close();
  await channel.deleteExchange(exchange).catch(() => undefined);
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await pool.end();
}
