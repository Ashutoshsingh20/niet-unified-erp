import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateRegulationVersionDto, PublishRegulationVersionDto } from './curriculum.dto';

interface RegulationRow {
  readonly id: string;
  readonly regulation_key: string;
  readonly version: number;
  readonly title: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly rule_schema_version: string;
  readonly rule_document: Record<string, unknown>;
  readonly impact_summary: string;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'RETIRED';
  readonly record_version: number;
  readonly policy_decision_reference: string | null;
  readonly published_at: Date | null;
}

export interface RegulationVersion {
  readonly id: string;
  readonly regulationKey: string;
  readonly version: number;
  readonly title: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly ruleSchemaVersion: string;
  readonly ruleDocument: Readonly<Record<string, unknown>>;
  readonly impactSummary: string;
  readonly status: RegulationRow['status'];
  readonly recordVersion: number;
  readonly policyDecisionReference: string | null;
  readonly publishedAt: string | null;
}

@Injectable()
export class CurriculumService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async create(input: CreateRegulationVersionDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(
          `INSERT INTO curriculum.regulation_versions
            (id, regulation_key, version, title, scope_type, scope_id, rule_schema_version,
             rule_document, impact_summary, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
          [id, input.regulationKey, input.version, input.title, input.scopeType, input.scopeId,
            input.ruleSchemaVersion, JSON.stringify(input.ruleDocument), input.impactSummary, actor.subjectId],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Regulation version already exists');
        throw error;
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.regulation.drafted', resourceType: 'curriculum-regulation', resourceId: id,
        details: { regulationKey: input.regulationKey, version: input.version,
          ruleSchemaVersion: input.ruleSchemaVersion, scopeType: input.scopeType, scopeId: input.scopeId } });
    });
    return { id };
  }

  async publish(id: string, input: PublishRegulationVersionDto, actor: Principal): Promise<void> {
    if (!this.config.get('ACADEMIC_POLICY_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Academic policy publication is disabled pending NIET approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const drafts = await manager.query<readonly RegulationRow[]>(
        `SELECT * FROM curriculum.regulation_versions WHERE id = $1 FOR UPDATE`, [id]);
      const draft = drafts[0];
      if (draft === undefined) throw new NotFoundException('Regulation version not found');
      this.policy.assertScope(actor, draft.scope_type, draft.scope_id);
      if (draft.status !== 'DRAFT' || draft.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Regulation version is not the expected draft version');
      }
      const updated = await manager.query<readonly { id: string }[]>(
        `UPDATE curriculum.regulation_versions
         SET status = 'PUBLISHED', record_version = record_version + 1,
             policy_decision_reference = $2, published_by = $3, published_at = clock_timestamp()
         WHERE id = $1 AND status = 'DRAFT' AND record_version = $4 RETURNING id`,
        [id, input.policyDecisionReference, actor.subjectId, input.expectedRecordVersion],
      );
      if (updated[0] === undefined) throw new ConflictException('Regulation version changed concurrently');
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'curriculum.regulation.published', resourceType: 'curriculum-regulation', resourceId: id,
        details: { regulationKey: draft.regulation_key, version: draft.version,
          policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'CurriculumRegulationPublished',
        aggregateType: 'curriculum-regulation', aggregateId: id, classification: 'INTERNAL',
        payload: { regulationId: id, regulationKey: draft.regulation_key, version: draft.version } });
    });
  }

  async get(id: string, actor: Principal): Promise<RegulationVersion> {
    const rows = await this.dataSource.query<readonly RegulationRow[]>(
      'SELECT * FROM curriculum.regulation_versions WHERE id = $1', [id]);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException('Regulation version not found');
    this.policy.assertScope(actor, row.scope_type, row.scope_id);
    return mapRow(row);
  }
}

function mapRow(row: RegulationRow): RegulationVersion {
  return { id: row.id, regulationKey: row.regulation_key, version: row.version, title: row.title,
    scopeType: row.scope_type, scopeId: row.scope_id, ruleSchemaVersion: row.rule_schema_version,
    ruleDocument: row.rule_document, impactSummary: row.impact_summary, status: row.status,
    recordVersion: row.record_version, policyDecisionReference: row.policy_decision_reference,
    publishedAt: row.published_at?.toISOString() ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
