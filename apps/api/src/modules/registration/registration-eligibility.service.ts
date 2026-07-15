import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateAdviserApprovalDto } from './registration-eligibility.dto';
interface ApprovalRow { id: string; student_id: string; period_id: string;
  offering_manifest_sha256: string; idempotency_key: string; policy_reference: string;
  evidence_reference: string; reason: string; scope_type: string; scope_id: string; approved_by: string }
@Injectable()
export class RegistrationEligibilityService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService) {}
  async approve(input: CreateAdviserApprovalDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const offeringIds = [...input.offeringIds].sort(); const manifest = offeringManifest(offeringIds);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['registration-adviser-approval', input.idempotencyKey])]);
      const existing = await manager.query<readonly ApprovalRow[]>(
        'SELECT * FROM registration.adviser_approvals WHERE idempotency_key=$1 FOR UPDATE',
      [input.idempotencyKey]);
      if (existing[0] !== undefined) return replay(existing[0], input, manifest, actor);
      const alignment = await manager.query<readonly { subject_id: string }[]>(`SELECT s.subject_id
        FROM student.records s JOIN registration.academic_periods p ON p.id=$2 AND p.status='PUBLISHED'
        WHERE s.id=$1 AND s.scope_type=$3 AND s.scope_id=$4 AND p.scope_type=$3 AND p.scope_id=$4`,
      [input.studentId, input.periodId, input.scopeType, input.scopeId]);
      if (alignment[0] === undefined) throw new NotFoundException('Aligned student and published period not found');
      if (alignment[0].subject_id === actor.subjectId) {
        throw new ForbiddenException('Student cannot approve their own registration plan');
      }
      const offerings = await manager.query<readonly { id: string }[]>(`SELECT id FROM registration.offerings
        WHERE id=ANY($1::uuid[]) AND period_id=$2 AND status='PUBLISHED'
          AND scope_type=$3 AND scope_id=$4 ORDER BY id`,
      [offeringIds, input.periodId, input.scopeType, input.scopeId]);
      if (offerings.length !== offeringIds.length) {
        throw new ConflictException('Adviser approval requires published offerings in the selected period and scope');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO registration.adviser_approvals
        (id,student_id,period_id,offering_manifest_sha256,idempotency_key,policy_reference,
         evidence_reference,reason,scope_type,scope_id,approved_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, input.studentId, input.periodId,
        manifest, input.idempotencyKey, input.policyReference, input.evidenceReference, input.reason,
        input.scopeType, input.scopeId, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'registration.adviser-approved', resourceType: 'registration-adviser-approval',
        resourceId: id, details: { studentId: input.studentId, periodId: input.periodId,
          offeringCount: offeringIds.length, offeringManifestSha256: manifest,
          policyReference: input.policyReference, evidenceReference: input.evidenceReference } });
      await this.evidence.outbox(manager, { eventType: 'RegistrationAdviserApproved',
        aggregateType: 'registration-adviser-approval', aggregateId: id, classification: 'CONFIDENTIAL',
        payload: { registrationAdviserApprovalId: id, studentId: input.studentId } });
      return { id, replayed: false };
    });
  }
}
export function offeringManifest(offeringIds: readonly string[]): string {
  return createHash('sha256').update([...offeringIds].sort().join(',')).digest('hex');
}
function replay(row: ApprovalRow, input: CreateAdviserApprovalDto, manifest: string,
  actor: Principal): { id: string; replayed: boolean } {
  if (row.student_id !== input.studentId || row.period_id !== input.periodId
    || row.offering_manifest_sha256 !== manifest || row.policy_reference !== input.policyReference
    || row.evidence_reference !== input.evidenceReference || row.reason !== input.reason
    || row.scope_type !== input.scopeType || row.scope_id !== input.scopeId
    || row.approved_by !== actor.subjectId) throw new ConflictException('Adviser approval replay differs');
  return { id: row.id, replayed: true };
}
