import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { EventPublisher, OutboxEvent } from './outbox.types';

export class RabbitEventPublisher implements EventPublisher {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;

  constructor(
    private readonly amqpUrl: string,
    private readonly exchange: string,
  ) {}

  async publish(event: OutboxEvent): Promise<void> {
    const channel = await this.ensureChannel();
    const envelope = {
      eventId: event.id,
      eventType: event.event_type,
      eventVersion: event.event_version,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      correlationId: event.correlation_id,
      causationId: event.causation_id,
      classification: event.classification,
      occurredAt: event.occurred_at.toISOString(),
      payload: event.payload,
    };
    try {
      channel.publish(this.exchange, event.event_type, Buffer.from(JSON.stringify(envelope)), {
        appId: 'niet-erp-outbox-worker',
        contentType: 'application/json',
        correlationId: event.correlation_id,
        deliveryMode: 2,
        messageId: event.id,
        timestamp: Math.floor(event.occurred_at.valueOf() / 1000),
        type: event.event_type,
        headers: {
          'x-event-version': event.event_version,
          'x-data-classification': event.classification,
        },
      });
      await channel.waitForConfirms();
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel !== undefined) return this.channel;
    this.connection = await connect(this.amqpUrl);
    this.connection.on('close', () => { this.channel = undefined; this.connection = undefined; });
    this.connection.on('error', () => undefined);
    this.channel = await this.connection.createConfirmChannel();
    await this.channel.assertExchange(this.exchange, 'topic', { durable: true, autoDelete: false });
    return this.channel;
  }

  private async reset(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    if (channel !== undefined) await channel.close().catch(() => undefined);
    if (connection !== undefined) await connection.close().catch(() => undefined);
  }
}
