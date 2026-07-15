import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateCapacityEntitlementDto, CreateCapacityPoolDto, DecideCapacityEntitlementDto,
  PublishCapacityPoolDto } from './registration-capacity.dto';

interface PoolRow { id: string; offering_id: string; pool_key: string; version: number; title: string;
  capacity: number; idempotency_key: string; status: string; record_version: number;
  scope_type: string; scope_id: string; created_by: string }
interface EntitlementRow { id: string; student_id: string; pool_id: string; idempotency_key: string;
  policy_reference: string; evidence_reference: string; evaluation_engine: string;
  evaluation_version: string; evaluation_trace: Record<string, unknown>; reason: string;
  status: string; record_version: number; scope_type: string; scope_id: string; requested_by: string }

@Injectable()
export class RegistrationCapacityService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async createPool(input: CreateCapacityPoolDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-capacity-pool', input.idempotencyKey])]);
      const prior = await manager.query<readonly PoolRow[]>(
        'SELECT * FROM registration.capacity_pools WHERE idempotency_key=$1 FOR UPDATE', [input.idempotencyKey]);
      if (prior[0] !== undefined) return replayPool(prior[0], input, actor);
      const offering = await manager.query<readonly { id: string }[]>(`SELECT id FROM registration.offerings
        WHERE id=$1 AND status='PUBLISHED' AND scope_type=$2 AND scope_id=$3`,
      [input.offeringId, input.scopeType, input.scopeId]);
      if (offering[0] === undefined) throw new ConflictException('Published offering in scope is required');
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO registration.capacity_pools
          (id,offering_id,pool_key,version,title,capacity,idempotency_key,scope_type,scope_id,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, input.offeringId, input.poolKey,
          input.version, input.title, input.capacity, input.idempotencyKey, input.scopeType,
          input.scopeId, actor.subjectId]);
      } catch (error) { throwConflict(error, 'Capacity pool version already exists'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.capacity-pool.drafted', resourceType: 'registration-capacity-pool',
        resourceId: id, details: { offeringId: input.offeringId, poolKey: input.poolKey,
          version: input.version, capacity: input.capacity } });
      return { id, replayed: false };
    });
  }
  async publishPool(id: string, input: PublishCapacityPoolDto, actor: Principal): Promise<void> {
    if (!this.config.get('REGISTRATION_RESERVED_CAPACITY_PUBLICATION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Reserved capacity publication is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly PoolRow[]>(
        'SELECT * FROM registration.capacity_pools WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0]; if (row === undefined) throw new NotFoundException('Capacity pool not found');
      this.policy.assertScope(actor, row.scope_type, row.scope_id);
      if (row.created_by === actor.subjectId) throw new ForbiddenException('Capacity pool creator cannot publish it');
      if (row.status !== 'DRAFT' || row.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Capacity pool is not the expected draft version');
      }
      try { await manager.query(`UPDATE registration.capacity_pools SET status='PUBLISHED',
        record_version=record_version+1,policy_decision_reference=$2,published_by=$3,
        published_at=clock_timestamp() WHERE id=$1`, [id, input.policyDecisionReference, actor.subjectId]); }
      catch (error) { throwConflict(error, 'Published reserved capacity exceeds offering capacity'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.capacity-pool.published', resourceType: 'registration-capacity-pool',
        resourceId: id, details: { policyDecisionReference: input.policyDecisionReference } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationCapacityPoolPublished',
        aggregateType: 'registration-capacity-pool', aggregateId: id, classification: 'INTERNAL',
        payload: { registrationCapacityPoolId: id, offeringId: row.offering_id } });
    });
  }
  async createEntitlement(input: CreateCapacityEntitlementDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-capacity-entitlement', input.idempotencyKey])]);
      const prior = await manager.query<readonly EntitlementRow[]>(
        'SELECT * FROM registration.capacity_entitlements WHERE idempotency_key=$1 FOR UPDATE',
      [input.idempotencyKey]);
      if (prior[0] !== undefined) return replayEntitlement(prior[0], input, actor);
      const aligned = await manager.query<readonly { id: string }[]>(`SELECT s.id FROM student.records s
        JOIN registration.capacity_pools p ON p.id=$2 AND p.status='PUBLISHED'
        WHERE s.id=$1 AND s.scope_type=$3 AND s.scope_id=$4 AND p.scope_type=$3 AND p.scope_id=$4`,
      [input.studentId, input.poolId, input.scopeType, input.scopeId]);
      if (aligned[0] === undefined) throw new ConflictException('Student and published pool must share scope');
      const id = randomUUID();
      await manager.query(`INSERT INTO registration.capacity_entitlements
        (id,student_id,pool_id,idempotency_key,policy_reference,evidence_reference,evaluation_engine,
         evaluation_version,evaluation_trace,reason,scope_type,scope_id,requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`, [id, input.studentId,
        input.poolId, input.idempotencyKey, input.policyReference, input.evidenceReference,
        input.evaluationEngine, input.evaluationVersion, JSON.stringify(input.evaluationTrace),
        input.reason, input.scopeType, input.scopeId, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.capacity-entitlement.requested',
        resourceType: 'registration-capacity-entitlement', resourceId: id,
        details: { studentId: input.studentId, poolId: input.poolId,
          policyReference: input.policyReference, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion } });
      return { id, replayed: false };
    });
  }
  async decideEntitlement(id: string, input: DecideCapacityEntitlementDto, actor: Principal): Promise<void> {
    if (!this.config.get('REGISTRATION_CAPACITY_ENTITLEMENT_APPROVAL_ENABLED', { infer: true })) {
      throw new ForbiddenException('Capacity entitlement approval is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly EntitlementRow[]>(
        'SELECT * FROM registration.capacity_entitlements WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0]; if (row === undefined) throw new NotFoundException('Capacity entitlement not found');
      this.policy.assertScope(actor, row.scope_type, row.scope_id);
      if (row.requested_by === actor.subjectId) throw new ForbiddenException('Entitlement requester cannot decide it');
      if (row.status !== 'DRAFT' || row.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Capacity entitlement is not the expected draft version');
      }
      await manager.query(`UPDATE registration.capacity_entitlements SET status=$2,
        record_version=record_version+1,decided_by=$3,decided_at=clock_timestamp() WHERE id=$1`,
      [id, input.outcome, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `registration.capacity-entitlement.${input.outcome.toLowerCase()}`,
        resourceType: 'registration-capacity-entitlement', resourceId: id,
        details: { poolId: row.pool_id, policyReference: row.policy_reference } });
      await this.evidence.outbox(manager, { eventType: `RegistrationCapacityEntitlement${titleCase(input.outcome)}`,
        aggregateType: 'registration-capacity-entitlement', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationCapacityEntitlementId: id, studentId: row.student_id,
          registrationCapacityPoolId: row.pool_id } });
    });
  }
}
function replayPool(row: PoolRow, input: CreateCapacityPoolDto,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.offering_id!==input.offeringId || row.pool_key!==input.poolKey || row.version!==input.version
    || row.title!==input.title || row.capacity!==input.capacity || row.scope_type!==input.scopeType
    || row.scope_id!==input.scopeId || row.created_by!==actor.subjectId) throw new ConflictException('Pool replay differs');
  return { id: row.id, replayed: true };
}
function replayEntitlement(row: EntitlementRow, input: CreateCapacityEntitlementDto,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.student_id!==input.studentId || row.pool_id!==input.poolId || row.policy_reference!==input.policyReference
    || row.evidence_reference!==input.evidenceReference || row.evaluation_engine!==input.evaluationEngine
    || row.evaluation_version!==input.evaluationVersion || row.reason!==input.reason
    || canonicalJson(row.evaluation_trace) !== canonicalJson(input.evaluationTrace)
    || row.scope_type!==input.scopeType || row.scope_id!==input.scopeId || row.requested_by!==actor.subjectId)
    throw new ConflictException('Entitlement replay differs');
  return { id: row.id, replayed: true };
}
function throwConflict(error: unknown, message: string): never {
  if (typeof error==='object' && error!==null && 'code' in error
    && ['23505','P0001'].includes(String(error.code))) throw new ConflictException(message); throw error;
}
function titleCase(value: string): string { return value.charAt(0) + value.slice(1).toLowerCase(); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
