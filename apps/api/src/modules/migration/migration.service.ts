import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { ApproveMigrationDto, CreateMigrationBatchDto, ReconcileMigrationDto,
  StageMigrationRowDto, VersionedMigrationCommandDto } from './migration.dto';

interface BatchRow { id: string; status: string; version: number; scope_type: string; scope_id: string;
  created_by: string }
@Injectable()
export class MigrationService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateMigrationBatchDto, actor: Principal): Promise<{ id: string }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      try {
        await manager.query(`INSERT INTO migration.batches
          (id,batch_key,source_system,source_manifest_sha256,mapping_version,
           scope_type,scope_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, input.batchKey, input.sourceSystem, input.sourceManifestSha256, input.mappingVersion,
          input.scopeType, input.scopeId, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Migration batch key already exists'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'migration.batch.created', resourceType: 'migration-batch', resourceId: id,
        details: { sourceSystem: input.sourceSystem, mappingVersion: input.mappingVersion,
          sourceManifestSha256: input.sourceManifestSha256 } });
    });
    return { id };
  }
  async stage(id: string, input: StageMigrationRowDto, actor: Principal): Promise<{ id: string }> {
    return this.dataSource.transaction(async (manager) => {
      const batch = await this.lock(manager, id);
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (!['CREATED', 'STAGED'].includes(batch.status)) throw new ConflictException('Batch no longer accepts rows');
      const ciphertext = Buffer.from(input.encryptedCandidateBase64, 'base64');
      if (ciphertext.length <= 16) throw new ConflictException('Encrypted candidate is too short');
      const rowId = randomUUID();
      try {
        await manager.query(`INSERT INTO migration.staged_rows
          (id,batch_id,source_key,source_row_sha256,extracted_at,encrypted_candidate,
           encryption_key_reference,staged_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rowId, id, input.sourceKey, input.sourceRowSha256, input.extractedAt, ciphertext,
          input.encryptionKeyReference, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Migration source key or row hash already exists in this batch'); }
      if (batch.status === 'CREATED') {
        await manager.query("UPDATE migration.batches SET status='STAGED',version=version+1 WHERE id=$1", [id]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'migration.row.staged', resourceType: 'migration-row', resourceId: rowId,
        details: { batchId: id, sourceRowSha256: input.sourceRowSha256 } });
      return { id: rowId };
    });
  }
  async validate(id: string, input: VersionedMigrationCommandDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lock(manager, id);
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (batch.status !== 'STAGED' || batch.version !== input.expectedVersion) {
        throw new ConflictException('Migration batch is not the expected staged version');
      }
      const rows = await manager.query<readonly { count: number }[]>(
        'SELECT count(*)::int count FROM migration.staged_rows WHERE batch_id=$1', [id]);
      if ((rows[0]?.count ?? 0) === 0) throw new ConflictException('Empty migration batches cannot be validated');
      await manager.query("UPDATE migration.batches SET status='VALIDATED',version=version+1 WHERE id=$1", [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'migration.batch.validated', resourceType: 'migration-batch', resourceId: id,
        details: { validationScope: 'ENVELOPE_AND_MANIFEST_ONLY' } });
    });
  }
  async reconcile(id: string, input: ReconcileMigrationDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lock(manager, id);
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (batch.status !== 'VALIDATED' || batch.version !== input.expectedVersion) {
        throw new ConflictException('Migration batch is not the expected validated version');
      }
      const rows = await manager.query<readonly { source_key: string; source_row_sha256: string }[]>(
        'SELECT source_key,source_row_sha256 FROM migration.staged_rows WHERE batch_id=$1 ORDER BY source_key', [id]);
      const stagedHash = createHash('sha256').update(rows.map((row) =>
        `${row.source_key}:${row.source_row_sha256}`).join('\n')).digest('hex');
      if (BigInt(input.expectedRowCount) !== BigInt(rows.length) || input.expectedRowsSha256 !== stagedHash) {
        throw new ConflictException('Migration control totals do not match staged evidence');
      }
      await manager.query(`INSERT INTO migration.control_totals
        (batch_id,expected_row_count,staged_row_count,expected_rows_sha256,
         staged_rows_sha256,reconciled_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.expectedRowCount, rows.length, input.expectedRowsSha256, stagedHash, actor.subjectId]);
      await manager.query("UPDATE migration.batches SET status='RECONCILED',version=version+1 WHERE id=$1", [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'migration.batch.reconciled', resourceType: 'migration-batch', resourceId: id,
        details: { rowCount: rows.length, rowsSha256: stagedHash } });
    });
  }
  async approve(id: string, input: ApproveMigrationDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lock(manager, id);
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (batch.status !== 'RECONCILED' || batch.version !== input.expectedVersion) {
        throw new ConflictException('Migration batch is not the expected reconciled version');
      }
      const totals = await manager.query<readonly { reconciled_by: string }[]>(
        'SELECT reconciled_by FROM migration.control_totals WHERE batch_id=$1', [id]);
      const requester = totals[0]?.reconciled_by;
      if (requester === undefined) throw new ConflictException('Reconciliation evidence is missing');
      if (requester === actor.subjectId) throw new ForbiddenException('Reconciler cannot approve migration batch');
      await manager.query(`INSERT INTO migration.approvals
        (id,batch_id,reconciliation_reference,requested_by,approved_by) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), id, input.reconciliationReference, requester, actor.subjectId]);
      await manager.query(`UPDATE migration.batches SET status='APPROVED',version=version+1,
        approved_by=$2,approved_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'migration.batch.approved', resourceType: 'migration-batch', resourceId: id,
        details: { reconciliationReference: input.reconciliationReference } });
      await this.evidence.outbox(manager, { eventType: 'MigrationBatchApproved',
        aggregateType: 'migration-batch', aggregateId: id, classification: 'RESTRICTED',
        payload: { migrationBatchId: id } });
    });
  }
  async apply(id: string, input: VersionedMigrationCommandDto, actor: Principal): Promise<void> {
    if (!this.config.get('MIGRATION_APPLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Migration application is disabled pending source mapping and owner approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lock(manager, id);
      this.policy.assertScope(actor, batch.scope_type, batch.scope_id);
      if (batch.status !== 'APPROVED' || batch.version !== input.expectedVersion) {
        throw new ConflictException('Migration batch is not the expected approved version');
      }
      throw new ConflictException('No approved domain migration adapter is installed for this batch');
    });
  }
  private async lock(manager: { query: DataSource['query'] }, id: string): Promise<BatchRow> {
    const rows = await manager.query<readonly BatchRow[]>(
      'SELECT * FROM migration.batches WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Migration batch not found');
    return rows[0];
  }
}
function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}
