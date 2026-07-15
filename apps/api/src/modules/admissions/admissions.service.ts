import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import type { Environment } from '../../config/environment';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import { StudentsService } from '../students/students.service';
import type { AcceptAdmissionOfferDto, AdmissionDocumentExceptionsQueryDto,
  AdmissionOfferExceptionsQueryDto,
  AttachAdmissionDocumentDto, ConvertAdmissionDto, CreateAdmissionChecklistDto,
  CreateApplicationDto, DecideApplicationDto, IssueAdmissionOfferDto,
  PublishAdmissionChecklistDto, SubmitApplicationDto, TransitionAdmissionOfferDto,
  VerifyAdmissionDocumentDto } from './admissions.dto';
interface ApplicationRow { id: string; applicant_subject_id: string; programme_key: string;
  payload_sha256: string; idempotency_key: string; scope_type: string; scope_id: string;
  status: string; version: number; encryption_key_reference: string; created_at: Date }
interface OfferRow { id: string; application_id: string; status: string; version: number;
  applicant_subject_id: string; payload_sha256: string; scope_type: string; scope_id: string;
  application_created_at: Date; programme_key: string; offer_reference: string;
  policy_reference: string | null; expires_at: Date | null; issued_by: string }
interface ChecklistRow { id: string; application_id: string; idempotency_key: string;
  policy_reference: string; items_manifest_sha256: string; status: string; version: number;
  configured_by: string; published_by: string | null; applicant_subject_id: string;
  scope_type: string; scope_id: string }
interface ChecklistItemRow { id: string; checklist_id: string; requirement_key: string;
  title: string; document_type_key: string; required: boolean; checklist_status: string;
  checklist_version: number; application_id: string; applicant_subject_id: string;
  scope_type: string; scope_id: string }
interface AttachmentRow { id: string; checklist_item_id: string; document_id: string;
  attached_by: string; application_id: string; applicant_subject_id: string;
  scope_type: string; scope_id: string }
interface VerificationRow { id: string; outcome: string; verification_engine: string;
  verification_version: string; verification_trace: Record<string, unknown>;
  evidence_sha256: string; reason: string; verified_by: string }
export interface AdmissionDocumentException {
  readonly checklistItemId: string;
  readonly applicationId: string;
  readonly programmeKey: string;
  readonly requirementKey: string;
  readonly title: string;
  readonly documentTypeKey: string;
  readonly latestOutcome: 'REJECTED' | null;
}
export interface AdmissionOfferException {
  readonly offerId: string;
  readonly applicationId: string;
  readonly programmeKey: string;
  readonly offerReference: string;
  readonly expiresAt: string;
  readonly policyReference: string;
}
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

  async createDocumentChecklist(applicationId: string, input: CreateAdmissionChecklistDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled('ADMISSION_DOCUMENT_CHECKLIST_ENABLED',
      'Admission document checklists are disabled pending NIET policy approval');
    const manifest = checklistManifest(input);
    return this.dataSource.transaction(async (manager) => {
      const application = await this.lock(manager, applicationId);
      this.policy.assertScope(actor, application.scope_type, application.scope_id);
      const existing = await manager.query<readonly ChecklistRow[]>(`SELECT c.*,a.applicant_subject_id,
        a.scope_type,a.scope_id FROM admissions.document_checklists c
        JOIN admissions.applications a ON a.id=c.application_id
        WHERE c.application_id=$1 OR c.idempotency_key=$2 FOR UPDATE OF c`,
      [applicationId, input.idempotencyKey]);
      if (existing[0] !== undefined) {
        const row = existing[0];
        if (row.application_id === applicationId && row.idempotency_key === input.idempotencyKey
          && row.policy_reference === input.policyReference && row.items_manifest_sha256 === manifest) {
          return { id: row.id, replayed: true };
        }
        throw new ConflictException('Admission checklist or idempotency key already has different content');
      }
      if (application.status !== 'SUBMITTED' || application.version !== input.expectedApplicationVersion) {
        throw new ConflictException('Application is not the expected submitted version');
      }
      const typeKeys = [...new Set(input.items.map((item) => item.documentTypeKey))];
      const activeTypes = await manager.query<readonly { type_key: string }[]>(
        "SELECT type_key FROM documents.types WHERE status='ACTIVE' AND type_key=ANY($1::text[])", [typeKeys]);
      if (activeTypes.length !== typeKeys.length) {
        throw new ConflictException('Every checklist item must reference an active document type');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO admissions.document_checklists
        (id,application_id,idempotency_key,policy_reference,items_manifest_sha256,configured_by)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, applicationId, input.idempotencyKey, input.policyReference, manifest, actor.subjectId]);
      for (const item of input.items) {
        await manager.query(`INSERT INTO admissions.document_checklist_items
          (id,checklist_id,requirement_key,title,document_type_key,required)
          VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), id, item.requirementKey, item.title,
          item.documentTypeKey, item.required]);
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.document-checklist.configured', resourceType: 'admission-document-checklist',
        resourceId: id, details: { applicationId, policyReference: input.policyReference,
          itemsManifestSha256: manifest, itemCount: input.items.length } });
      return { id, replayed: false };
    });
  }

  async publishDocumentChecklist(id: string, input: PublishAdmissionChecklistDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    this.assertEnabled('ADMISSION_DOCUMENT_CHECKLIST_ENABLED',
      'Admission document checklists are disabled pending NIET policy approval');
    return this.dataSource.transaction(async (manager) => {
      const checklist = await this.lockChecklist(manager, id);
      this.policy.assertScope(actor, checklist.scope_type, checklist.scope_id);
      if (checklist.status === 'PUBLISHED') {
        if (checklist.version === input.expectedChecklistVersion + 1
          && checklist.published_by === actor.subjectId) return { replayed: true };
        throw new ConflictException('Admission checklist already has a different publication');
      }
      if (checklist.version !== input.expectedChecklistVersion) {
        throw new ConflictException('Admission checklist is not the expected draft version');
      }
      if (checklist.configured_by === actor.subjectId) {
        throw new ForbiddenException('Checklist maker cannot publish the checklist');
      }
      await manager.query(`UPDATE admissions.document_checklists SET status='PUBLISHED',
        version=version+1,published_by=$2,published_at=clock_timestamp() WHERE id=$1`,
      [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.document-checklist.published', resourceType: 'admission-document-checklist',
        resourceId: id, details: { applicationId: checklist.application_id,
          itemsManifestSha256: checklist.items_manifest_sha256 } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionDocumentChecklistPublished',
        aggregateType: 'admission-document-checklist', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionDocumentChecklistId: id, admissionApplicationId: checklist.application_id } });
      return { replayed: false };
    });
  }

  async attachDocument(itemId: string, input: AttachAdmissionDocumentDto,
    actor: Principal): Promise<{ id: string; replayed: boolean }> {
    this.assertEnabled('ADMISSION_DOCUMENT_CHECKLIST_ENABLED',
      'Admission document checklists are disabled pending NIET policy approval');
    return this.dataSource.transaction(async (manager) => {
      const item = await this.lockChecklistItem(manager, itemId);
      this.policy.assertScope(actor, item.scope_type, item.scope_id);
      if (item.applicant_subject_id !== actor.subjectId) {
        throw new ForbiddenException('Only the applicant can attach checklist documents');
      }
      if (item.checklist_status !== 'PUBLISHED') {
        throw new ConflictException('Admission document checklist is not published');
      }
      const existing = await manager.query<readonly { id: string }[]>(`SELECT id
        FROM admissions.document_attachments WHERE checklist_item_id=$1 AND document_id=$2`,
      [itemId, input.documentId]);
      if (existing[0] !== undefined) return { id: existing[0].id, replayed: true };
      const satisfied = await manager.query<readonly { exists: boolean }[]>(`SELECT EXISTS (
        SELECT 1 FROM admissions.document_attachments da JOIN admissions.document_verifications dv
          ON dv.attachment_id=da.id AND dv.outcome='VERIFIED' WHERE da.checklist_item_id=$1) exists`, [itemId]);
      if (satisfied[0]?.exists === true) throw new ConflictException('Checklist requirement is already verified');
      const documents = await manager.query<readonly { owner_subject_id: string; scope_type: string;
        scope_id: string; status: string; type_key: string }[]>(`SELECT r.owner_subject_id,r.scope_type,
        r.scope_id,r.status,t.type_key FROM documents.records r JOIN documents.types t ON t.id=r.document_type_id
        WHERE r.id=$1`, [input.documentId]);
      const document = documents[0];
      if (document?.status !== 'CLEAN' || document.owner_subject_id !== item.applicant_subject_id
        || document.scope_type !== item.scope_type || document.scope_id !== item.scope_id
        || document.type_key !== item.document_type_key) {
        throw new ConflictException('Document does not match the clean, owned checklist requirement');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO admissions.document_attachments
        (id,checklist_item_id,document_id,attached_by) VALUES ($1,$2,$3,$4)`,
      [id, itemId, input.documentId, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.document.attached', resourceType: 'admission-document-attachment',
        resourceId: id, details: { applicationId: item.application_id, checklistItemId: itemId,
          documentId: input.documentId } });
      await this.evidence.outbox(manager, { eventType: 'AdmissionDocumentAttached',
        aggregateType: 'admission-document-attachment', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionDocumentAttachmentId: id, admissionApplicationId: item.application_id } });
      return { id, replayed: false };
    });
  }

  async verifyDocument(attachmentId: string, input: VerifyAdmissionDocumentDto,
    actor: Principal): Promise<{ id: string; checklistComplete: boolean; replayed: boolean }> {
    this.assertEnabled('ADMISSION_DOCUMENT_VERIFICATION_ENABLED',
      'Admission document verification is disabled pending NIET policy approval');
    return this.dataSource.transaction(async (manager) => {
      const attachment = await this.lockAttachment(manager, attachmentId);
      this.policy.assertScope(actor, attachment.scope_type, attachment.scope_id);
      if (attachment.attached_by === actor.subjectId) {
        throw new ForbiddenException('Document submitter cannot verify the same attachment');
      }
      const existing = await manager.query<readonly VerificationRow[]>(
        'SELECT * FROM admissions.document_verifications WHERE attachment_id=$1', [attachmentId]);
      if (existing[0] !== undefined) {
        const row = existing[0];
        if (row.outcome === input.outcome && row.verification_engine === input.verificationEngine
          && row.verification_version === input.verificationVersion
          && canonicalJson(row.verification_trace) === canonicalJson(input.verificationTrace)
          && row.evidence_sha256 === input.evidenceSha256 && row.reason === input.reason
          && row.verified_by === actor.subjectId) {
          return { id: row.id, checklistComplete: await this.checklistComplete(manager,
            attachment.application_id), replayed: true };
        }
        throw new ConflictException('Attachment already has different verification evidence');
      }
      const id = randomUUID();
      await manager.query(`INSERT INTO admissions.document_verifications
        (id,attachment_id,outcome,verification_engine,verification_version,verification_trace,
         evidence_sha256,reason,verified_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [id, attachmentId, input.outcome, input.verificationEngine, input.verificationVersion,
        JSON.stringify(input.verificationTrace), input.evidenceSha256, input.reason, actor.subjectId]);
      const checklistComplete = await this.checklistComplete(manager, attachment.application_id);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `admission.document.${input.outcome.toLowerCase()}`,
        resourceType: 'admission-document-verification', resourceId: id,
        details: { applicationId: attachment.application_id, attachmentId,
          verificationEngine: input.verificationEngine, verificationVersion: input.verificationVersion,
          evidenceSha256: input.evidenceSha256, checklistComplete } });
      await this.evidence.outbox(manager, { eventType: input.outcome === 'VERIFIED'
        ? 'AdmissionDocumentVerified' : 'AdmissionDocumentRejected',
        aggregateType: 'admission-document-verification', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionDocumentVerificationId: id,
          admissionApplicationId: attachment.application_id } });
      const completionRows = checklistComplete && input.outcome === 'VERIFIED'
        ? await manager.query<readonly { emitted: boolean }[]>(`SELECT EXISTS (
            SELECT 1 FROM platform.outbox_events
            WHERE aggregate_type='admission-application' AND aggregate_id=$1
              AND event_type='AdmissionDocumentsComplete') emitted`, [attachment.application_id])
        : [];
      if (checklistComplete && input.outcome === 'VERIFIED' && !completionRows[0]?.emitted) {
        await this.evidence.outbox(manager, { eventType: 'AdmissionDocumentsComplete',
          aggregateType: 'admission-application', aggregateId: attachment.application_id,
          classification: 'RESTRICTED', payload: { admissionApplicationId: attachment.application_id } });
      }
      return { id, checklistComplete, replayed: false };
    });
  }

  async listDocumentExceptions(input: AdmissionDocumentExceptionsQueryDto,
    actor: Principal): Promise<{ items: AdmissionDocumentException[]; nextCursor: string | null }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const rows = await this.dataSource.query<readonly { checklist_item_id: string;
      application_id: string; programme_key: string; requirement_key: string; title: string;
      document_type_key: string; latest_outcome: 'REJECTED' | null }[]>(`SELECT i.id checklist_item_id,
      a.id application_id,a.programme_key,i.requirement_key,i.title,i.document_type_key,
      latest.outcome latest_outcome FROM admissions.document_checklist_items i
      JOIN admissions.document_checklists c ON c.id=i.checklist_id AND c.status='PUBLISHED'
      JOIN admissions.applications a ON a.id=c.application_id
      LEFT JOIN LATERAL (SELECT dv.outcome FROM admissions.document_attachments da
        LEFT JOIN admissions.document_verifications dv ON dv.attachment_id=da.id
        WHERE da.checklist_item_id=i.id ORDER BY da.attached_at DESC LIMIT 1) latest ON true
      WHERE i.required AND a.scope_type=$1 AND a.scope_id=$2 AND ($3::uuid IS NULL OR i.id>$3)
        AND NOT EXISTS (SELECT 1 FROM admissions.document_attachments da
          JOIN admissions.document_verifications dv ON dv.attachment_id=da.id AND dv.outcome='VERIFIED'
          WHERE da.checklist_item_id=i.id)
      ORDER BY i.id LIMIT $4`, [input.scopeType, input.scopeId, input.after ?? null, input.limit + 1]);
    const hasNext = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return { items: page.map((row) => ({ checklistItemId: row.checklist_item_id,
      applicationId: row.application_id, programmeKey: row.programme_key,
      requirementKey: row.requirement_key, title: row.title,
      documentTypeKey: row.document_type_key, latestOutcome: row.latest_outcome })),
    nextCursor: hasNext ? page.at(-1)?.checklist_item_id ?? null : null };
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
      if (input.outcome === 'OFFERED'
        && this.config.get('ADMISSION_DOCUMENT_ENFORCEMENT_ENABLED', { infer: true })) {
        await this.assertRequiredDocumentsVerified(manager, id);
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
      const expiry = await manager.query<readonly { future: boolean }[]>(
        'SELECT $1::timestamptz > clock_timestamp() future', [input.expiresAt]);
      if (expiry[0]?.future !== true) throw new ConflictException('Admission offer expiry must be in the future');
      const id = randomUUID();
      try {
        await manager.query(`INSERT INTO admissions.offers
          (id,application_id,offer_reference,terms_manifest_sha256,expires_at,policy_reference,issued_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, applicationId, input.offerReference,
          input.termsManifestSha256, input.expiresAt, input.policyReference, actor.subjectId]);
      } catch (error) { throwUnique(error, 'Admission application or offer reference already has an offer'); }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'admission.offer.issued', resourceType: 'admission-offer', resourceId: id,
        details: { applicationId, termsManifestSha256: input.termsManifestSha256,
          expiresAt: input.expiresAt, policyReference: input.policyReference } });
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
      const validity = await manager.query<readonly { valid: boolean }[]>(
        'SELECT $1::timestamptz > clock_timestamp() valid', [offer.expires_at]);
      if (offer.expires_at === null || validity[0]?.valid !== true) {
        throw new ConflictException('Admission offer has expired');
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

  declineOffer(id: string, input: TransitionAdmissionOfferDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    return this.transitionOffer(id, input, actor, 'DECLINED');
  }

  withdrawOffer(id: string, input: TransitionAdmissionOfferDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    return this.transitionOffer(id, input, actor, 'WITHDRAWN');
  }

  expireOffer(id: string, input: TransitionAdmissionOfferDto,
    actor: Principal): Promise<{ replayed: boolean }> {
    return this.transitionOffer(id, input, actor, 'EXPIRED');
  }

  async listOfferExceptions(input: AdmissionOfferExceptionsQueryDto,
    actor: Principal): Promise<{ items: AdmissionOfferException[]; nextCursor: string | null }> {
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const rows = await this.dataSource.query<readonly { offer_id: string; application_id: string;
      programme_key: string; offer_reference: string; expires_at: Date;
      policy_reference: string }[]>(`SELECT o.id offer_id,a.id application_id,a.programme_key,
      o.offer_reference,o.expires_at,o.policy_reference FROM admissions.offers o
      JOIN admissions.applications a ON a.id=o.application_id
      WHERE o.status='ISSUED' AND o.expires_at<=$1::timestamptz
        AND a.scope_type=$2 AND a.scope_id=$3 AND ($4::uuid IS NULL OR o.id>$4)
      ORDER BY o.id LIMIT $5`, [input.dueBefore, input.scopeType, input.scopeId,
      input.after ?? null, input.limit + 1]);
    const hasNext = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return { items: page.map((row) => ({ offerId: row.offer_id,
      applicationId: row.application_id, programmeKey: row.programme_key,
      offerReference: row.offer_reference, expiresAt: row.expires_at.toISOString(),
      policyReference: row.policy_reference })),
    nextCursor: hasNext ? page.at(-1)?.offer_id ?? null : null };
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

  private assertEnabled(key: keyof Pick<Environment, 'ADMISSION_DOCUMENT_CHECKLIST_ENABLED'
    | 'ADMISSION_DOCUMENT_VERIFICATION_ENABLED' | 'ADMISSION_OFFER_LIFECYCLE_ENABLED'>,
  message: string): void {
    if (!this.config.get(key, { infer: true })) throw new ForbiddenException(message);
  }

  private async lockChecklist(manager: EntityManager, id: string): Promise<ChecklistRow> {
    const rows = await manager.query<readonly ChecklistRow[]>(`SELECT c.*,a.applicant_subject_id,
      a.scope_type,a.scope_id FROM admissions.document_checklists c
      JOIN admissions.applications a ON a.id=c.application_id WHERE c.id=$1 FOR UPDATE OF c,a`, [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission document checklist not found');
    return rows[0];
  }

  private async lockChecklistItem(manager: EntityManager, id: string): Promise<ChecklistItemRow> {
    const rows = await manager.query<readonly ChecklistItemRow[]>(`SELECT i.*,c.status checklist_status,
      c.version checklist_version,c.application_id,a.applicant_subject_id,a.scope_type,a.scope_id
      FROM admissions.document_checklist_items i JOIN admissions.document_checklists c ON c.id=i.checklist_id
      JOIN admissions.applications a ON a.id=c.application_id WHERE i.id=$1 FOR UPDATE OF c,a`, [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission checklist item not found');
    return rows[0];
  }

  private async lockAttachment(manager: EntityManager, id: string): Promise<AttachmentRow> {
    const rows = await manager.query<readonly AttachmentRow[]>(`SELECT da.*,c.application_id,
      a.applicant_subject_id,a.scope_type,a.scope_id FROM admissions.document_attachments da
      JOIN admissions.document_checklist_items i ON i.id=da.checklist_item_id
      JOIN admissions.document_checklists c ON c.id=i.checklist_id
      JOIN admissions.applications a ON a.id=c.application_id WHERE da.id=$1 FOR UPDATE OF c,a`, [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission document attachment not found');
    return rows[0];
  }

  private async checklistComplete(manager: EntityManager, applicationId: string): Promise<boolean> {
    const rows = await manager.query<readonly { complete: boolean }[]>(`SELECT
      EXISTS (SELECT 1 FROM admissions.document_checklists
        WHERE application_id=$1 AND status='PUBLISHED')
      AND NOT EXISTS (SELECT 1 FROM admissions.document_checklist_items i
        JOIN admissions.document_checklists c ON c.id=i.checklist_id
        WHERE c.application_id=$1 AND c.status='PUBLISHED' AND i.required
          AND NOT EXISTS (SELECT 1 FROM admissions.document_attachments da
            JOIN admissions.document_verifications dv ON dv.attachment_id=da.id AND dv.outcome='VERIFIED'
            WHERE da.checklist_item_id=i.id)) complete`, [applicationId]);
    return rows[0]?.complete === true;
  }

  private async assertRequiredDocumentsVerified(manager: EntityManager, applicationId: string): Promise<void> {
    if (!await this.checklistComplete(manager, applicationId)) {
      throw new ConflictException('Required admission documents are not completely verified');
    }
  }

  private async lock(manager: EntityManager, id: string): Promise<ApplicationRow> {
    const rows = await manager.query<readonly ApplicationRow[]>(
      'SELECT * FROM admissions.applications WHERE id=$1 FOR UPDATE', [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission application not found');
    return rows[0];
  }
  private async lockOffer(manager: EntityManager, id: string): Promise<OfferRow> {
    const rows = await manager.query<readonly OfferRow[]>(`SELECT o.*,a.applicant_subject_id,
      a.payload_sha256,a.scope_type,a.scope_id,a.programme_key,a.created_at application_created_at
      FROM admissions.offers o JOIN admissions.applications a ON a.id=o.application_id
      WHERE o.id=$1 FOR UPDATE OF o,a`, [id]);
    if (rows[0] === undefined) throw new NotFoundException('Admission offer not found');
    return rows[0];
  }

  private async transitionOffer(id: string, input: TransitionAdmissionOfferDto, actor: Principal,
    target: 'DECLINED' | 'WITHDRAWN' | 'EXPIRED'): Promise<{ replayed: boolean }> {
    this.assertEnabled('ADMISSION_OFFER_LIFECYCLE_ENABLED',
      'Admission offer lifecycle actions are disabled pending NIET policy approval');
    return this.dataSource.transaction(async (manager) => {
      const offer = await this.lockOffer(manager, id);
      this.policy.assertScope(actor, offer.scope_type, offer.scope_id);
      const existing = await manager.query<readonly { transition: string; reason: string;
        policy_reference: string; acted_by: string }[]>(
        'SELECT transition,reason,policy_reference,acted_by FROM admissions.offer_lifecycle_events WHERE offer_id=$1',
      [id]);
      if (offer.status === target && offer.version === input.expectedOfferVersion + 1
        && existing[0]?.transition === target && existing[0].reason === input.reason
        && existing[0].policy_reference === input.policyReference
        && existing[0].acted_by === actor.subjectId) return { replayed: true };
      if (offer.status !== 'ISSUED' || offer.version !== input.expectedOfferVersion) {
        throw new ConflictException('Admission offer is not the expected issued version');
      }
      if (offer.policy_reference === null || offer.policy_reference !== input.policyReference) {
        throw new ConflictException('Offer transition does not reference the governing issuance policy');
      }
      if (target === 'DECLINED') {
        if (offer.applicant_subject_id !== actor.subjectId) {
          throw new ForbiddenException('Only the applicant can decline this offer');
        }
      } else if (offer.issued_by === actor.subjectId) {
        throw new ForbiddenException('Offer issuer cannot perform the exceptional lifecycle transition');
      }
      if (target === 'EXPIRED') {
        const expiry = await manager.query<readonly { expired: boolean }[]>(
          'SELECT $1::timestamptz <= clock_timestamp() expired', [offer.expires_at]);
        if (offer.expires_at === null || expiry[0]?.expired !== true) {
          throw new ConflictException('Admission offer has not reached its configured expiry');
        }
      }
      await manager.query(`INSERT INTO admissions.offer_lifecycle_events
        (id,offer_id,application_id,transition,from_status,to_status,reason,policy_reference,acted_by)
        VALUES ($1,$2,$3,$4,'ISSUED',$4,$5,$6,$7)`, [randomUUID(), id, offer.application_id,
        target, input.reason, input.policyReference, actor.subjectId]);
      await manager.query('UPDATE admissions.offers SET status=$2,version=version+1 WHERE id=$1', [id, target]);
      await manager.query(`UPDATE admissions.applications SET status='WITHDRAWN',version=version+1
        WHERE id=$1 AND status='OFFERED'`, [offer.application_id]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `admission.offer.${target.toLowerCase()}`, resourceType: 'admission-offer', resourceId: id,
        details: { applicationId: offer.application_id, reason: input.reason,
          policyReference: input.policyReference } });
      const eventTypes = { DECLINED: 'AdmissionOfferDeclined', WITHDRAWN: 'AdmissionOfferWithdrawn',
        EXPIRED: 'AdmissionOfferExpired' } as const;
      await this.evidence.outbox(manager, { eventType: eventTypes[target],
        aggregateType: 'admission-offer', aggregateId: id, classification: 'RESTRICTED',
        payload: { admissionOfferId: id, admissionApplicationId: offer.application_id } });
      return { replayed: false };
    });
  }
  private async replay(manager: EntityManager, input: CreateApplicationDto): Promise<{ id: string; replayed: boolean }> {
    const rows = await manager.query<readonly ApplicationRow[]>(
      'SELECT * FROM admissions.applications WHERE idempotency_key=$1', [input.idempotencyKey]);
    const row = rows[0];
    if (row?.applicant_subject_id === input.applicantSubjectId && row.programme_key === input.programmeKey
      && row.payload_sha256 === input.payloadSha256 && row.encryption_key_reference === input.encryptionKeyReference
      && row.scope_type === input.scopeType && row.scope_id === input.scopeId) return { id: row.id, replayed: true };
    throw new ConflictException('Admission idempotency key already has different content');
  }
}

function checklistManifest(input: CreateAdmissionChecklistDto): string {
  const items = [...input.items].sort((left, right) => left.requirementKey.localeCompare(right.requirementKey));
  return createHash('sha256').update(canonicalJson(items)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
function throwUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}
