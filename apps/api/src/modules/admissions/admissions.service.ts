import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import { StudentsService } from '../students/students.service';
import type { AcceptAdmissionOfferDto, ConvertAdmissionDto, CreateApplicationDto,
  DecideApplicationDto, IssueAdmissionOfferDto, SubmitApplicationDto } from './admissions.dto';
interface ApplicationRow { id: string; applicant_subject_id: string; programme_key: string;
  payload_sha256: string; idempotency_key: string; scope_type: string; scope_id: string;
  status: string; version: number; encryption_key_reference: string; created_at: Date }
interface OfferRow { id: string; application_id: string; status: string; version: number;
  applicant_subject_id: string; payload_sha256: string; scope_type: string; scope_id: string;
  application_created_at: Date }
@Injectable()
export class AdmissionsService {
  constructor(private readonly dataSource: DataSource, private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    private readonly config: ConfigService<Environment, true>,
    private readonly students: StudentsService) {}
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
  async issueOffer(applicationId: string, input: IssueAdmissionOfferDto,
    actor: Principal): Promise<{ id: string }> {
    if (!this.config.get('ADMISSION_DECISION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Admission offer issuance is disabled pending NIET policy approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const application = await this.lock(manager, applicationId);
      this.policy.assertScope(actor, application.scope_type, application.scope_id);
      if (application.status !== 'OFFERED' || application.version !== input.expectedApplicationVersion) {
        throw new ConflictException('Application is not the expected offered version');
      }
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO admissions.offers
          (id,application_id,offer_reference,terms_manifest_sha256,issued_by)
          VALUES ($1,$2,$3,$4,$5)`, [id, applicationId, input.offerReference,
          input.termsManifestSha256, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Admission application or offer reference already has an offer'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.offer.issued', resourceType: 'admission-offer', resourceId: id,
        details: { applicationId, termsManifestSha256: input.termsManifestSha256 } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionOfferIssued',
        aggregateType: 'admission-offer', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionOfferId: id, admissionApplicationId: applicationId } });
      return { id };
    });
  }
  async acceptOffer(id: string, input: AcceptAdmissionOfferDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const offer = await this.lockOffer(manager, id);
      this.policy.assertScope(actor, offer.scope_type, offer.scope_id);
      if (offer.applicant_subject_id !== actor.subjectId) {
        throw new ForbiddenException('Only the applicant can accept this offer');
      }
      if (offer.status !== 'ISSUED' || offer.version !== input.expectedOfferVersion) {
        throw new ConflictException('Admission offer is not the expected issued version');
      }
      await manager.query(`UPDATE admissions.offers SET status='ACCEPTED',version=version+1,
        accepted_by=$2,accepted_at=clock_timestamp() WHERE id=$1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.offer.accepted', resourceType: 'admission-offer', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'OfferAccepted',
        aggregateType: 'admission-offer', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionOfferId: id, admissionApplicationId: offer.application_id } });
    });
  }
  async convert(id: string, input: ConvertAdmissionDto,
    actor: Principal): Promise<{ studentId: string; replayed: boolean }> {
    if (!this.config.get('STUDENT_CONVERSION_ENABLED', { infer: true })) {
      throw new ForbiddenException('Student conversion is disabled pending NIET identity and admission approval');
    }
    return this.dataSource.transaction(async (manager) => {
      const offer = await this.lockOffer(manager, id);
      this.policy.assertScope(actor, offer.scope_type, offer.scope_id);
      const existing = await manager.query<readonly { student_id: string; idempotency_key: string;
        mapping_engine: string; mapping_version: string; display_name: string }[]>(`SELECT c.student_id,
        c.idempotency_key,c.mapping_engine,c.mapping_version,s.display_name FROM admissions.conversions c
        JOIN student.records s ON s.id=c.student_id WHERE c.offer_id=$1 OR c.idempotency_key=$2`,
      [id, input.idempotencyKey]);
      if (existing[0] !== undefined) {
        const row = existing[0];
        if (row.idempotency_key === input.idempotencyKey && row.mapping_engine === input.mappingEngine
          && row.mapping_version === input.mappingVersion && row.display_name === input.displayName) {
          return { studentId: row.student_id, replayed: true };
        }
        throw new ConflictException('Admission conversion or idempotency key already has different content');
      }
      if (offer.status !== 'ACCEPTED' || offer.version !== input.expectedOfferVersion) {
        throw new ConflictException('Admission offer is not the expected accepted version');
      }
      const student = await this.students.createInTransaction(manager, {
        subjectId: offer.applicant_subject_id, displayName: input.displayName,
        scopeType: offer.scope_type, scopeId: offer.scope_id, sourceSystem: 'admissions',
        sourceKey: offer.application_id, sourceExtractedAt: offer.application_created_at.toISOString(),
        mappingVersion: input.mappingVersion, sourceRowSha256: offer.payload_sha256,
        idempotencyKey: input.idempotencyKey,
      }, actor);
      await manager.query(`INSERT INTO admissions.conversions
        (id,application_id,offer_id,student_id,idempotency_key,mapping_engine,
         mapping_version,mapping_trace,converted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [randomUUID(), offer.application_id, id, student.id, input.idempotencyKey,
        input.mappingEngine, input.mappingVersion, JSON.stringify(input.mappingTrace), actor.subjectId]);
      await manager.query("UPDATE admissions.applications SET status='CONVERTED',version=version+1 WHERE id=$1",
        [offer.application_id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.application.converted', resourceType: 'admission-application',
        resourceId: offer.application_id, details: { studentId: student.id,
          mappingEngine: input.mappingEngine, mappingVersion: input.mappingVersion } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionConverted',
        aggregateType: 'admission-application', aggregateId: offer.application_id,
        classification: 'RESTRICTED', payload: { admissionApplicationId: offer.application_id,
          studentId: student.id } });
      return { studentId: student.id, replayed: false };
    });
  }
  private async lock(manager: { query: DataSource['query'] }, id: string): Promise<ApplicationRow> {
    const rows = await manager.query<readonly ApplicationRow[]>(
      'SELECT * FROM admissions.applications WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission application not found');
    return rows[0];
  }
  private async lockOffer(manager: { query: DataSource['query'] }, id: string): Promise<OfferRow> {
    const rows = await manager.query<readonly OfferRow[]>(`SELECT o.*,a.applicant_subject_id,
      a.payload_sha256,a.scope_type,a.scope_id,a.created_at application_created_at
      FROM admissions.offers o JOIN admissions.applications a ON a.id=o.application_id
      WHERE o.id=$1 FOR UPDATE OF o,a`, [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission offer not found');
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
function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}
