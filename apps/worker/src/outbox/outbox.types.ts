export interface OutboxEvent {
  readonly id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurred_at: Date;
  readonly attempts: number;
}

export interface EventPublisher {
  publish(event: OutboxEvent): Promise<void>;
  close(): Promise<void>;
}

