import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestContextService } from '../request-context/request-context.service';

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

@Injectable()
export class TransactionalEvidenceService {
  constructor(private readonly requestContext: RequestContextService) {}

  async audit(
    manager: EntityManager,
    input: {
      readonly actorSubjectId: string;
      readonly action: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly outcome?: 'SUCCEEDED' | 'DENIED' | 'FAILED';
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO platform.audit_events
        (id, actor_subject_id, action, resource_type, resource_id, outcome, correlation_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [randomUUID(), input.actorSubjectId, input.action, input.resourceType, input.resourceId,
        input.outcome ?? 'SUCCEEDED', this.correlationId(), JSON.stringify(input.details ?? {})],
    );
  }

  async outbox(
    manager: EntityManager,
    input: {
      readonly eventType: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly classification?: DataClassification;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO platform.outbox_events
        (id, event_type, event_version, aggregate_type, aggregate_id, correlation_id,
         classification, payload)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), input.eventType, input.aggregateType, input.aggregateId,
        this.correlationId(), input.classification ?? 'INTERNAL', JSON.stringify(input.payload)],
    );
  }

  private correlationId(): string {
    return this.requestContext.getCorrelationId() ?? 'internal';
  }
}

