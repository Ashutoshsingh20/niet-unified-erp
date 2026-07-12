import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateStudentRecordDto } from './students.dto';

interface StudentRow {
  readonly id: string;
  readonly subject_id: string | null;
  readonly display_name: string;
  readonly status: StudentRecord['status'];
  readonly scope_type: string;
  readonly scope_id: string;
  readonly source_system: string;
  readonly source_key: string;
  readonly source_extracted_at: Date;
  readonly mapping_version: string;
  readonly source_row_sha256: string;
  readonly migration_batch_id: string | null;
  readonly idempotency_key: string;
  readonly version: number;
}

export interface StudentRecord {
  readonly id: string;
  readonly subjectId: string | null;
  readonly displayName: string;
  readonly status: 'PROVISIONAL' | 'ACTIVE' | 'SUSPENDED' | 'ON_LEAVE' | 'COMPLETED'
    | 'WITHDRAWN' | 'TERMINATED';
  readonly scopeType: string;
  readonly scopeId: string;
  readonly sourceSystem: string;
  readonly sourceKey: string;
  readonly sourceExtractedAt: string;
  readonly mappingVersion: string;
  readonly migrationBatchId: string | null;
  readonly version: number;
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
  ) {}

  async create(input: CreateStudentRecordDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      const id = randomUUID();
      const inserted = await manager.query<readonly { id: string }[]>(
        `INSERT INTO student.records
          (id, subject_id, display_name, scope_type, scope_id, source_system, source_key,
           source_extracted_at, mapping_version, source_row_sha256, migration_batch_id,
           idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, input.subjectId ?? null, input.displayName, input.scopeType, input.scopeId,
          input.sourceSystem, input.sourceKey, input.sourceExtractedAt, input.mappingVersion,
          input.sourceRowSha256, input.migrationBatchId ?? null, input.idempotencyKey, actor.subjectId],
      );
      if (inserted[0] === undefined) {
        const existing = await manager.query<readonly StudentRow[]>(
          `SELECT * FROM student.records
           WHERE idempotency_key = $1 OR (source_system = $2 AND source_key = $3)
           ORDER BY CASE WHEN idempotency_key = $1 THEN 0 ELSE 1 END LIMIT 1`,
          [input.idempotencyKey, input.sourceSystem, input.sourceKey],
        );
        const row = existing[0];
        if (row !== undefined && sameCreate(row, input)) return { id: row.id, replayed: true };
        throw new ConflictException('Student source or idempotency key already has different content');
      }
      await manager.query(
        `INSERT INTO student.status_history
          (id, student_id, from_status, to_status, record_version, reason, changed_by)
         VALUES ($1, $2, NULL, 'PROVISIONAL', 1, $3, $4)`,
        [randomUUID(), id, 'Created from provenance-preserving source conversion', actor.subjectId],
      );
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'student.record.created', resourceType: 'student-record', resourceId: id,
        details: { scopeType: input.scopeType, scopeId: input.scopeId,
          sourceSystem: input.sourceSystem, mappingVersion: input.mappingVersion } });
      await this.evidence.outbox(manager, { eventType: 'StudentCreated',
        aggregateType: 'student-record', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { studentId: id, scopeType: input.scopeType, scopeId: input.scopeId } });
      return { id, replayed: false };
    });
  }

  async get(id: string, actor: Principal): Promise<StudentRecord> {
    const rows = await this.dataSource.query<readonly StudentRow[]>(
      `SELECT id, subject_id, display_name, status, scope_type, scope_id, source_system,
              source_key, source_extracted_at, mapping_version, source_row_sha256,
              migration_batch_id, idempotency_key, version
       FROM student.records WHERE id = $1`, [id]);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException('Student record not found');
    this.policy.assertScope(actor, row.scope_type, row.scope_id);
    return mapRow(row);
  }
}

function sameCreate(row: StudentRow, input: CreateStudentRecordDto): boolean {
  return row.subject_id === (input.subjectId ?? null) && row.display_name === input.displayName
    && row.scope_type === input.scopeType && row.scope_id === input.scopeId
    && row.source_system === input.sourceSystem && row.source_key === input.sourceKey
    && row.source_extracted_at.toISOString() === new Date(input.sourceExtractedAt).toISOString()
    && row.mapping_version === input.mappingVersion && row.source_row_sha256 === input.sourceRowSha256
    && row.migration_batch_id === (input.migrationBatchId ?? null);
}

function mapRow(row: StudentRow): StudentRecord {
  return { id: row.id, subjectId: row.subject_id, displayName: row.display_name,
    status: row.status, scopeType: row.scope_type, scopeId: row.scope_id,
    sourceSystem: row.source_system, sourceKey: row.source_key,
    sourceExtractedAt: row.source_extracted_at.toISOString(), mappingVersion: row.mapping_version,
    migrationBatchId: row.migration_batch_id, version: row.version };
}
