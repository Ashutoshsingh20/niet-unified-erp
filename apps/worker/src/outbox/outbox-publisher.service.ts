import type { Pool, PoolClient } from 'pg';
import type { EventPublisher, OutboxEvent } from './outbox.types';

export class OutboxPublisherService {
  constructor(
    private readonly pool: Pool,
    private readonly publisher: EventPublisher,
    private readonly maxAttempts: number,
  ) {}

  async processOne(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxEvent>(
        `SELECT id, event_type, event_version, aggregate_type, aggregate_id, correlation_id,
                causation_id, classification, payload, occurred_at, attempts
         FROM platform.outbox_events
         WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= clock_timestamp()
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const event = result.rows[0];
      if (event === undefined) {
        await client.query('COMMIT');
        return false;
      }
      try {
        await this.publisher.publish(event);
        await client.query(
          `UPDATE platform.outbox_events SET published_at = clock_timestamp(), last_error = NULL
           WHERE id = $1`, [event.id]);
      } catch (error) {
        await this.recordFailure(client, event, error);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordFailure(client: PoolClient, event: OutboxEvent, error: unknown): Promise<void> {
    const nextAttempt = event.attempts + 1;
    const delaySeconds = calculateRetrySeconds(nextAttempt);
    const message = sanitizeOperationalError(error);
    await client.query(
      `UPDATE platform.outbox_events
       SET attempts = attempts + 1, last_error = $2,
           next_attempt_at = clock_timestamp() + make_interval(secs => $3),
           failed_at = CASE WHEN attempts + 1 >= $4 THEN clock_timestamp() ELSE NULL END
       WHERE id = $1`, [event.id, message, delaySeconds, this.maxAttempts]);
  }
}

export function calculateRetrySeconds(attempt: number): number {
  return Math.min(3600, 2 ** Math.min(Math.max(attempt, 1), 12));
}

export function sanitizeOperationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown publisher error';
  return message
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^@\s]+@/gi, '$1[redacted]@')
    .replaceAll(/[\r\n\t]/g, ' ')
    .slice(0, 1000);
}
