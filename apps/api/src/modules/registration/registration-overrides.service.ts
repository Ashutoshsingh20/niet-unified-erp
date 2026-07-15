import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import { offeringManifest } from './registration-eligibility.service';
import type { CreateRegistrationOverrideDto, DecideRegistrationOverrideDto }
  from './registration-overrides.dto';

interface OverrideRow { id: string; student_id: string; period_id: string; offering_manifest_sha256: string;
  exception_type: string; idempotency_key: string; policy_reference: string; evidence_reference: string;
  reason: string; evaluation_engine: string; evaluation_version: string;
  evaluation_trace: Record<string, unknown>; scope_type: string; scope_id: string; status: string;
  record_version: number; requested_by: string }

@Injectable()
export class RegistrationOverridesService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}

  async create(input: CreateRegistrationOverrideDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const offeringIds = [...input.offeringIds].sort(); const manifest = offeringManifest(offeringIds);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-override', input.idempotencyKey])]);
      const prior = await manager.query<readonly OverrideRow[]>(
        'SELECT * FROM registration.override_authorizations WHERE idempotency_key=$1 FOR UPDATE',
      [input.idempotencyKey]);
      if (prior[0] !== undefined) return replay(prior[0], input, manifest, actor);
      const alignment = await manager.query<readonly { id: string }[]>(`SELECT s.id
        FROM student.records s JOIN registration.academic_periods p ON p.id=$2 AND p.status='PUBLISHED'
        WHERE s.id=$1 AND s.scope_type=$3 AND s.scope_id=$4
          AND p.scope_type=$3 AND p.scope_id=$4`,
      [input.studentId, input.periodId, input.scopeType, input.scopeId]);
      const offerings = await manager.query<readonly { id: string }[]>(`SELECT id
        FROM registration.offerings WHERE id=ANY($1::uuid[]) AND period_id=$2 AND status='PUBLISHED'
          AND scope_type=$3 AND scope_id=$4 ORDER BY id`,
      [offeringIds, input.periodId, input.scopeType, input.scopeId]);
      if (alignment[0] === undefined || offerings.length !== offeringIds.length) {
        throw new ConflictException('Override requires an aligned student, period, and published offerings');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO registration.override_authorizations
        (id,student_id,period_id,offering_manifest_sha256,exception_type,idempotency_key,
         policy_reference,evidence_reference,reason,evaluation_engine,evaluation_version,
         evaluation_trace,scope_type,scope_id,requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [id, input.studentId, input.periodId, manifest, input.exceptionType, input.idempotencyKey,
        input.policyReference, input.evidenceReference, input.reason, input.evaluationEngine,
        input.evaluationVersion, JSON.stringify(input.evaluationTrace), input.scopeType,
        input.scopeId, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.override.requested', resourceType: 'registration-override', resourceId: id,
        details: { exceptionType: input.exceptionType, studentId: input.studentId,
          periodId: input.periodId, offeringManifestSha256: manifest,
          policyReference: input.policyReference, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion } });
      return { id, replayed: false };
    });
  }

  async decide(id: string, input: DecideRegistrationOverrideDto, actor: Principal): Promise<void> {
    if (!this.config.get('REGISTRATION_OVERRIDE_APPROVAL_ENABLED', { infer: true })) {
      throw new ForbiddenException('Registration override approval is disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<readonly OverrideRow[]>(
        'SELECT * FROM registration.override_authorizations WHERE id=$1 FOR UPDATE', [id]);
      const row = rows[0];
      if (row === undefined) throw new NotFoundException('Registration override not found');
      this.policy.assertScope(actor, row.scope_type, row.scope_id);
      if (row.requested_by === actor.subjectId) {
        throw new ForbiddenException('Registration override requester cannot decide it');
      }
      if (row.status !== 'DRAFT' || row.record_version !== input.expectedRecordVersion) {
        throw new ConflictException('Registration override is not the expected draft version');
      }
      await manager.query(`UPDATE registration.override_authorizations SET status=$2,
        record_version=record_version+1,decided_by=$3,decided_at=clock_timestamp() WHERE id=$1`,
      [id, input.outcome, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `registration.override.${input.outcome.toLowerCase()}`,
        resourceType: 'registration-override', resourceId: id,
        details: { exceptionType: row.exception_type, policyReference: row.policy_reference,
          evaluationEngine: row.evaluation_engine, evaluationVersion: row.evaluation_version } });
      await this.evidence.outbox(manager, { eventType: `RegistrationOverride${titleCase(input.outcome)}`,
        aggregateType: 'registration-override', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationOverrideId: id, studentId: row.student_id,
          exceptionType: row.exception_type } });
    });
  }
}

function replay(row: OverrideRow, input: CreateRegistrationOverrideDto, manifest: string,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.student_id !== input.studentId || row.period_id !== input.periodId
    || row.offering_manifest_sha256 !== manifest || row.exception_type !== input.exceptionType
    || row.policy_reference !== input.policyReference || row.evidence_reference !== input.evidenceReference
    || row.reason !== input.reason || row.evaluation_engine !== input.evaluationEngine
    || row.evaluation_version !== input.evaluationVersion
    || canonicalJson(row.evaluation_trace) !== canonicalJson(input.evaluationTrace)
    || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
    || row.requested_by !== actor.subjectId) throw new ConflictException('Override replay differs');
  return { id: row.id, replayed: true };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function titleCase(value: string): string { return value.charAt(0) + value.slice(1).toLowerCase(); }
