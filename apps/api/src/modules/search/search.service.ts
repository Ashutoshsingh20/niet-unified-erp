import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import { OpenSearchQueryAdapter } from '../../platform/search/opensearch-query.adapter';
import type { SearchQueryDto, UpsertSearchRecordDto } from './search.dto';

export interface SearchResultItem {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly title: string;
  readonly summary: string;
  readonly classification: string;
  readonly actionPath: string;
}

interface RegistryRow {
  readonly id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly title: string;
  readonly summary: string;
  readonly required_permission: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly classification: string;
  readonly action_path: string;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly search: OpenSearchQueryAdapter,
  ) {}

  async query(input: SearchQueryDto, actor: Principal): Promise<{ items: SearchResultItem[] }> {
    const candidateIds = await this.search.findCandidateIds(input.q.trim(), actor, input.limit * 2);
    if (candidateIds.length === 0) return { items: [] };
    const rows = await this.dataSource.query<readonly RegistryRow[]>(
      `SELECT id, source_type, source_id, title, summary, required_permission, scope_type,
              scope_id, classification, action_path
       FROM search.records WHERE id = ANY($1::uuid[]) AND projection_status = 'INDEXED'`,
      [candidateIds],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: SearchResultItem[] = [];
    for (const id of candidateIds) {
      const row = byId.get(id);
      if (row === undefined) continue;
      try {
        this.policy.assertAllowed(actor, { permission: row.required_permission });
        this.policy.assertScope(actor, row.scope_type, row.scope_id);
      } catch (error) {
        if (error instanceof ForbiddenException) continue;
        throw error;
      }
      items.push({ sourceType: row.source_type, sourceId: row.source_id, title: row.title,
        summary: row.summary, classification: row.classification, actionPath: row.action_path });
      if (items.length >= input.limit) break;
    }
    return { items };
  }

  async upsert(input: UpsertSearchRecordDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      const id = randomUUID();
      const rows = await manager.query<readonly { id: string }[]>(
        `WITH changed AS (
           INSERT INTO search.records
             (id, source_type, source_id, source_version, title, summary, required_permission,
              scope_type, scope_id, classification, action_path, projection_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')
           ON CONFLICT (source_type, source_id) DO UPDATE SET
             source_version = EXCLUDED.source_version, title = EXCLUDED.title,
             summary = EXCLUDED.summary, required_permission = EXCLUDED.required_permission,
             scope_type = EXCLUDED.scope_type, scope_id = EXCLUDED.scope_id,
             classification = EXCLUDED.classification, action_path = EXCLUDED.action_path,
             projection_status = 'PENDING', index_attempts = 0, next_attempt_at = clock_timestamp(),
             failed_at = NULL, last_error = NULL, updated_at = clock_timestamp()
           WHERE search.records.source_version < EXCLUDED.source_version
           RETURNING id
         ) SELECT id FROM changed`,
        [id, input.sourceType, input.sourceId, input.sourceVersion, input.title, input.summary,
          input.requiredPermission, input.scopeType, input.scopeId, input.classification, input.actionPath],
      );
      const recordId = rows[0]?.id;
      if (recordId === undefined) {
        const existing = await manager.query<readonly (RegistryRow & { source_version: number })[]>(
          `SELECT id, source_type, source_id, source_version, title, summary, required_permission,
                  scope_type, scope_id, classification, action_path
           FROM search.records WHERE source_type = $1 AND source_id = $2`,
          [input.sourceType, input.sourceId],
        );
        const same = existing[0];
        if (same !== undefined && same.source_version === input.sourceVersion
          && same.title === input.title && same.summary === input.summary
          && same.required_permission === input.requiredPermission
          && same.scope_type === input.scopeType && same.scope_id === input.scopeId
          && same.classification === input.classification && same.action_path === input.actionPath) {
          return { id: same.id };
        }
        throw new ConflictException('Search source version must increase when indexed content changes');
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'search.record.registered', resourceType: 'search-record', resourceId: recordId,
        details: { sourceType: input.sourceType, sourceId: input.sourceId,
          sourceVersion: input.sourceVersion, scopeType: input.scopeType, scopeId: input.scopeId } });
      await this.evidence.outbox(manager, { eventType: 'SearchProjectionRequested',
        aggregateType: 'search-record', aggregateId: recordId, classification: input.classification,
        payload: { recordId } });
      return { id: recordId };
    });
  }
}
