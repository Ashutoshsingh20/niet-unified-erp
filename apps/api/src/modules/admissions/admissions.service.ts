import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import type { CreateApplicationDto, DecideApplicationDto, SubmitApplicationDto } from './admissions.dto';
interface ApplicationRow { id: string; applicant_subject_id: string; programme_key: string;
  payload_sha256: string; idempotency_key: string; scope_type: string; scope_id: string;
  status: string; version: number; encryption_key_reference: string }
@Injectable()
export class AdmissionsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>) {}
  async create(input: CreateApplicationDto, actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const encrypted = Buffer.from(input.encryptedPayloadBase64, 'base64');
    if (encrypted.length <= 16) throw new ConflictException('Encrypted application payload is too short');
    return this.dataSource.transaction(async (manager) => {
      const id = randomUUID();
      const inserted = await manager.query<readonly { id: string }[]>(`INSERT INTO admissions.applications
        (id,applicant_subject_id,programme_key,encrypted_payload,encryption_key_reference,
         payload_sha256,idempotency_key,scope_type,scope_id,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [id, input.applicantSubjectId,
        input.programmeKey, encrypted, input.encryptionKeyReference, input.payloadSha256,
        input.idempotencyKey, input.scopeType, input.scopeId, actor.subjectId]);
      if (inserted[0] === undefined) return this.replay(manager, input);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.application.drafted', resourceType: 'admission-application', resourceId: id,
        details: { programmeKey: input.programmeKey, payloadSha256: input.payloadSha256,
          scopeType: input.scopeType, scopeId: input.scopeId } });
      return { id, replayed: false };
    });
  }
  async submit(id: string, input: SubmitApplicationDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const application = await this.lock(manager, id);
      this.policy.assertScope(actor, application.scope_type, application.scope_id);
      if (application.applicant_subject_id !== actor.subjectId) {
        throw new ForbiddenException('Only the applicant can submit this application');
      }
      if (application.status !== 'DRAFT' || application.version !== input.expectedVersion) {
        throw new ConflictException('Application is not the expected draft version');
      }
      await manager.query(`INSERT INTO admissions.submissions
        (id,application_id,payload_sha256,evidence_manifest_sha256,submitted_by)
        VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), id, application.payload_sha256,
        input.evidenceManifestSha256, actor.subjectId]);
      await manager.query(`UPDATE admissions.applications SET status='SUBMITTED',version=version+1,
        submitted_at=clock_timestamp() WHERE id=$1`, [id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.application.submitted', resourceType: 'admission-application', resourceId: id,
        details: { evidenceManifestSha256: input.evidenceManifestSha256 } });
      await this.evidence.outbox(manager, { eventType: 'ApplicationSubmitted',
        aggregateType: 'admission-application', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionApplicationId: id } });
    });
  }
  async decide(id: string, input: DecideApplicationDto, actor: Principal): Promise<void> {
    if (!this.config.get('ADMISSION_DECISION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Admission decisions are disabled pending NIET policy approval');
    }
    await this.dataSource.transaction(async (manager) => {
      const application = await this.lock(manager, id);
      this.policy.assertScope(actor, application.scope_type, application.scope_id);
      if (application.status !== 'SUBMITTED' || application.version !== input.expectedVersion) {
        throw new ConflictException('Application is not the expected submitted version');
      }
      await manager.query(`INSERT INTO admissions.decisions
        (id,application_id,outcome,evaluation_engine,evaluation_version,regulation_reference,
         evaluation_trace,reason,decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [randomUUID(), id, input.outcome, input.evaluationEngine, input.evaluationVersion,
        input.regulationReference, JSON.stringify(input.evaluationTrace), input.reason, actor.subjectId]);
      await manager.query(`UPDATE admissions.applications SET status=$2,version=version+1,
        decided_at=clock_timestamp() WHERE id=$1`, [id, input.outcome]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.application.decided', resourceType: 'admission-application', resourceId: id,
        details: { outcome: input.outcome, evaluationEngine: input.evaluationEngine,
          evaluationVersion: input.evaluationVersion, regulationReference: input.regulationReference } });
      await this.evidence.outbox(manager, { eventType: input.outcome === 'OFFERED' ? 'AdmissionOffered' : 'AdmissionRejected',
        aggregateType: 'admission-application', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionApplicationId: id } });
    });
  }
  private async lock(manager: { query: DataSource['query'] }, id: string): Promise<ApplicationRow> {
    const rows = await manager.query<readonly ApplicationRow[]>(
      'SELECT * FROM admissions.applications WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission application not found');
    return rows[0];
  }
  private async replay(manager: { query: DataSource['query'] }, input: CreateApplicationDto): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly ApplicationRow[]>(
      'SELECT * FROM admissions.applications WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    if (row?.applicant_subject_id === input.applicantSubjectId && row.programme_key === input.programmeKey
      && row.payload_sha256 === input.payloadSha256 && row.encryption_key_reference === input.encryptionKeyReference
      && row.scope_type === input.scopeType && row.scope_id === input.scopeId) return { id: row.id, replayed: true };
    throw new ConflictException('Admission idempotency key already has different content');
  }
}
