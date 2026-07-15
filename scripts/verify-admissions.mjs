import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { DocumentsService } from '../apps/api/dist/modules/documents/documents.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

class VerificationObjectStorage {
  metadata;
  async createQuarantineUpload(input) {
    this.metadata = { sizeBytes: 128, contentType: input.contentType, sha256: input.sha256 };
    return { url: 'http://storage.invalid/admission-upload',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      requiredHeaders: { 'content-type': input.contentType } };
  }
  async headQuarantineObject() {
    if (this.metadata === undefined) throw new Error('No synthetic admission document');
    return this.metadata;
  }
  async promoteToClean() {}
  async createCleanDownload() { return 'http://storage.invalid/admission-download'; }
}
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Admissions verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const students = new StudentsService(dataSource, policy, evidence);
  const enabled = new AdmissionsService(dataSource, policy, evidence, { get: () => true }, students);
  const disabled = new AdmissionsService(dataSource, policy, evidence, { get: () => false }, students);
  const documents = new DocumentsService(dataSource, policy, evidence, new VerificationObjectStorage());
  const applicant = { subjectId: `applicant-${suffix}`, assuranceLevel: 2, permissions: new Set(), scopes: { organization: [scopeId] } };
  const reviewer = { ...applicant, subjectId: `reviewer-${suffix}` };
  const publisher = { ...applicant, subjectId: `publisher-${suffix}` };
  const scanner = { ...applicant, subjectId: `scanner-${suffix}` };
  const outsider = { ...reviewer, subjectId: `outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const input = { applicantSubjectId: applicant.subjectId, programmeKey: `PROGRAMME-${suffix}`,
    encryptedPayloadBase64: randomBytes(64).toString('base64'), encryptionKeyReference: 'synthetic-key-v1',
    payloadSha256: 'a'.repeat(64), idempotencyKey: randomUUID(), scopeType: 'organization', scopeId };
  const created = await enabled.create(input, applicant); const replay = await enabled.create(input, applicant);
  if (!replay.replayed || replay.id !== created.id) throw new Error('Admission draft retry was not idempotent');
  let changedRejected = false;
  try { await enabled.create({ ...input, payloadSha256: 'b'.repeat(64) }, applicant); }
  catch (error) { changedRejected = error instanceof ConflictException; }
  if (!changedRejected) throw new Error('Changed admission retry was accepted');
  let submitOwnership = false;
  try { await enabled.submit(created.id, { expectedVersion: 1, evidenceManifestSha256: 'c'.repeat(64) }, reviewer); }
  catch (error) { submitOwnership = error instanceof ForbiddenException; }
  if (!submitOwnership) throw new Error('Non-applicant submitted application');
  await enabled.submit(created.id, { expectedVersion: 1, evidenceManifestSha256: 'c'.repeat(64) }, applicant);

  const documentTypeKey = `admission.identity-${suffix}`;
  const documentType = await documents.createType({ typeKey: documentTypeKey, version: 1,
    title: 'Synthetic admission identity evidence', allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 1024, classification: 'RESTRICTED', retentionDays: 30 }, reviewer);
  await documents.publishType(documentType.id, reviewer);
  const documentSha = 'e'.repeat(64);
  const upload = await documents.initiateUpload({ documentTypeKey, filename: 'identity.pdf',
    mimeType: 'application/pdf', sizeBytes: 128, sha256: documentSha,
    scopeType: 'organization', scopeId }, applicant);
  await documents.completeUpload(upload.documentId, applicant);
  await documents.recordScan(upload.documentId, { outcome: 'CLEAN', scannerEngine: 'synthetic-av',
    signatureVersion: '1', detectedMimeType: 'application/pdf', computedSha256: documentSha,
    reason: 'Synthetic admission document is clean' }, scanner);
  await documents.promote(upload.documentId, scanner);

  const checklistInput = { idempotencyKey: randomUUID(), policyReference: 'SYNTHETIC-DOCUMENT-POLICY',
    expectedApplicationVersion: 2, items: [
      { requirementKey: 'identity-proof', title: 'Identity proof', documentTypeKey, required: true },
      { requirementKey: 'optional-evidence', title: 'Optional evidence', documentTypeKey, required: false },
    ] };
  let checklistDisabled = false;
  try { await disabled.createDocumentChecklist(created.id, checklistInput, reviewer); }
  catch (error) { checklistDisabled = error instanceof ForbiddenException; }
  if (!checklistDisabled) throw new Error('Admission checklist bypassed its disabled gate');
  const checklist = await enabled.createDocumentChecklist(created.id, checklistInput, reviewer);
  const checklistReplay = await enabled.createDocumentChecklist(created.id, checklistInput, reviewer);
  if (!checklistReplay.replayed || checklistReplay.id !== checklist.id) {
    throw new Error('Admission checklist retry was not idempotent');
  }
  let changedChecklistRejected = false;
  try { await enabled.createDocumentChecklist(created.id,
    { ...checklistInput, policyReference: 'DIFFERENT-SYNTHETIC-POLICY' }, reviewer); }
  catch (error) { changedChecklistRejected = error instanceof ConflictException; }
  if (!changedChecklistRejected) throw new Error('Changed admission checklist replay was accepted');
  let checklistMakerDenied = false;
  try { await enabled.publishDocumentChecklist(checklist.id, { expectedChecklistVersion: 1 }, reviewer); }
  catch (error) { checklistMakerDenied = error instanceof ForbiddenException; }
  if (!checklistMakerDenied) throw new Error('Admission checklist maker published the checklist');
  let checklistPublicationDisabled = false;
  try { await disabled.publishDocumentChecklist(checklist.id, { expectedChecklistVersion: 1 }, publisher); }
  catch (error) { checklistPublicationDisabled = error instanceof ForbiddenException; }
  if (!checklistPublicationDisabled) throw new Error('Checklist publication bypassed its disabled gate');
  await enabled.publishDocumentChecklist(checklist.id, { expectedChecklistVersion: 1 }, publisher);
  const publicationReplay = await enabled.publishDocumentChecklist(
    checklist.id, { expectedChecklistVersion: 1 }, publisher);
  if (!publicationReplay.replayed) throw new Error('Checklist publication retry was not idempotent');
  const checklistItems = await dataSource.query(`SELECT id,requirement_key
    FROM admissions.document_checklist_items WHERE checklist_id=$1`, [checklist.id]);
  const requiredItem = checklistItems.find((item) => item.requirement_key === 'identity-proof');
  if (requiredItem === undefined) throw new Error('Required checklist item was not persisted');
  const initialExceptions = await enabled.listDocumentExceptions({ scopeType: 'organization', scopeId,
    limit: 50 }, reviewer);
  if (!initialExceptions.items.some((item) => item.applicationId === created.id
    && item.requirementKey === 'identity-proof')) throw new Error('Missing document was absent from worklist');
  let attachmentOwnershipDenied = false;
  try { await enabled.attachDocument(requiredItem.id, { documentId: upload.documentId }, reviewer); }
  catch (error) { attachmentOwnershipDenied = error instanceof ForbiddenException; }
  if (!attachmentOwnershipDenied) throw new Error('Non-applicant attached an admission document');
  const attachment = await enabled.attachDocument(requiredItem.id, { documentId: upload.documentId }, applicant);
  const attachmentReplay = await enabled.attachDocument(
    requiredItem.id, { documentId: upload.documentId }, applicant);
  if (!attachmentReplay.replayed || attachmentReplay.id !== attachment.id) {
    throw new Error('Admission document attachment retry was not idempotent');
  }
  const verificationInput = { outcome: 'VERIFIED', verificationEngine: 'synthetic-document-verifier',
    verificationVersion: 'v1', verificationTrace: { result: 'SYNTHETIC_MATCH' },
    evidenceSha256: 'f'.repeat(64), reason: 'Synthetic identity document matched' };
  let verificationDisabled = false;
  try { await disabled.verifyDocument(attachment.id, verificationInput, reviewer); }
  catch (error) { verificationDisabled = error instanceof ForbiddenException; }
  if (!verificationDisabled) throw new Error('Admission document verification bypassed its disabled gate');
  let verifierMakerDenied = false;
  try { await enabled.verifyDocument(attachment.id, verificationInput, applicant); }
  catch (error) { verifierMakerDenied = error instanceof ForbiddenException; }
  if (!verifierMakerDenied) throw new Error('Document submitter verified the same attachment');
  const verification = await enabled.verifyDocument(attachment.id, verificationInput, reviewer);
  const verificationReplay = await enabled.verifyDocument(attachment.id, verificationInput, reviewer);
  if (!verification.checklistComplete || !verificationReplay.replayed
    || verificationReplay.id !== verification.id) throw new Error('Document verification retry or completion failed');
  const remainingExceptions = await enabled.listDocumentExceptions({ scopeType: 'organization', scopeId,
    limit: 50 }, reviewer);
  if (remainingExceptions.items.some((item) => item.applicationId === created.id)) {
    throw new Error('Verified required document remained in the exception worklist');
  }
  let exceptionScopeDenied = false;
  try { await enabled.listDocumentExceptions({ scopeType: 'organization', scopeId, limit: 50 }, outsider); }
  catch (error) { exceptionScopeDenied = error instanceof ForbiddenException; }
  if (!exceptionScopeDenied) throw new Error('Admission document worklist ignored tenant scope');

  const decision = { outcome: 'OFFERED', evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
    regulationReference: 'SYNTHETIC-VERIFICATION-ONLY', evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' },
    reason: 'Synthetic evaluator offer', expectedVersion: 2 };
  let disabledGate = false;
  try { await disabled.decide(created.id, decision, reviewer); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Admission decision bypassed disabled gate');
  await enabled.decide(created.id, decision, reviewer);
  const missingInput = { ...input, programmeKey: `MISSING-DOCS-${suffix}`,
    idempotencyKey: randomUUID(), payloadSha256: '1'.repeat(64) };
  const missing = await enabled.create(missingInput, applicant);
  await enabled.submit(missing.id, { expectedVersion: 1, evidenceManifestSha256: '2'.repeat(64) }, applicant);
  const missingChecklist = await enabled.createDocumentChecklist(missing.id,
    { idempotencyKey: randomUUID(), policyReference: 'SYNTHETIC-MISSING-DOCUMENT-POLICY',
      expectedApplicationVersion: 2, items: [{ requirementKey: 'identity-proof',
        title: 'Identity proof', documentTypeKey, required: true }] }, reviewer);
  await enabled.publishDocumentChecklist(missingChecklist.id, { expectedChecklistVersion: 1 }, publisher);
  let missingDocumentsBlocked = false;
  try { await enabled.decide(missing.id, { ...decision, expectedVersion: 2 }, reviewer); }
  catch (error) { missingDocumentsBlocked = error instanceof ConflictException; }
  if (!missingDocumentsBlocked) throw new Error('Offer decision ignored required admission documents');
  const offer = await enabled.issueOffer(created.id, { offerReference: `OFFER-${suffix}`,
    termsManifestSha256: 'd'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference: 'SYNTHETIC-OFFER-LIFECYCLE-POLICY', expectedApplicationVersion: 3 }, reviewer);
  let applicantOwnership = false;
  try { await enabled.acceptOffer(offer.id, { expectedOfferVersion: 1 }, reviewer); }
  catch (error) { applicantOwnership = error instanceof ForbiddenException; }
  if (!applicantOwnership) throw new Error('Non-applicant accepted admission offer');
  await enabled.acceptOffer(offer.id, { expectedOfferVersion: 1 }, applicant);
  const conversionInput = { idempotencyKey: randomUUID(), displayName: 'Synthetic Converted Student',
    mappingEngine: 'synthetic-mapper', mappingVersion: 'v1',
    mappingTrace: { result: 'SYNTHETIC_MAPPING' }, expectedOfferVersion: 2 };
  let conversionDisabled = false;
  try { await disabled.convert(offer.id, conversionInput, reviewer); }
  catch (error) { conversionDisabled = error instanceof ForbiddenException; }
  if (!conversionDisabled) throw new Error('Student conversion bypassed disabled gate');
  const conversion = await enabled.convert(offer.id, conversionInput, reviewer);
  const conversionReplay = await enabled.convert(offer.id, conversionInput, reviewer);
  if (conversion.replayed || !conversionReplay.replayed
    || conversionReplay.studentId !== conversion.studentId) throw new Error('Admission conversion was not idempotent');
  let mutationRejected = false;
  try { await dataSource.query("UPDATE admissions.decisions SET reason='tampered' WHERE application_id=$1", [created.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Admission decision evidence was mutable');
  let verificationMutationRejected = false;
  try { await dataSource.query("UPDATE admissions.document_verifications SET reason='tampered' WHERE id=$1",
    [verification.id]); } catch { verificationMutationRejected = true; }
  if (!verificationMutationRejected) throw new Error('Admission document verification evidence was mutable');
  const rows = await dataSource.query(`SELECT a.status,a.version,d.evaluation_engine,d.regulation_reference,
    o.status offer_status,o.version offer_version,c.mapping_engine,c.mapping_version,
    dc.status checklist_status,dc.version checklist_version,
    s.status student_status,s.source_system,s.source_key,s.source_row_sha256,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-application' AND resource_id=a.id::text) audits,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-offer' AND resource_id=o.id::text) offer_audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-application'
      AND aggregate_id=a.id::text) application_events,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-offer'
      AND aggregate_id=o.id::text) offer_events,
    (SELECT count(*)::int FROM admissions.document_attachments da
      JOIN admissions.document_checklist_items i ON i.id=da.checklist_item_id
      WHERE i.checklist_id=dc.id) attachments,
    (SELECT count(*)::int FROM admissions.document_verifications dv
      JOIN admissions.document_attachments da ON da.id=dv.attachment_id
      JOIN admissions.document_checklist_items i ON i.id=da.checklist_item_id
      WHERE i.checklist_id=dc.id) verifications,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-document-checklist'
      AND resource_id=dc.id::text) checklist_audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-document-checklist'
      AND aggregate_id=dc.id::text) checklist_events
    FROM admissions.applications a JOIN admissions.decisions d ON d.application_id=a.id
    JOIN admissions.offers o ON o.application_id=a.id JOIN admissions.conversions c ON c.application_id=a.id
    JOIN student.records s ON s.id=c.student_id
    JOIN admissions.document_checklists dc ON dc.application_id=a.id WHERE a.id=$1`, [created.id]);
  const proof = rows[0];
  if (proof?.status !== 'CONVERTED' || proof?.version !== 4 || proof?.evaluation_engine !== 'synthetic-evaluator'
    || proof?.regulation_reference !== 'SYNTHETIC-VERIFICATION-ONLY' || proof?.offer_status !== 'ACCEPTED'
    || proof?.offer_version !== 2 || proof?.mapping_engine !== 'synthetic-mapper' || proof?.mapping_version !== 'v1'
    || proof?.checklist_status !== 'PUBLISHED' || proof?.checklist_version !== 2
    || proof?.student_status !== 'PROVISIONAL' || proof?.source_system !== 'admissions'
    || proof?.source_key !== created.id || proof?.source_row_sha256 !== input.payloadSha256
    || proof?.audits !== 4 || proof?.offer_audits !== 2 || proof?.application_events !== 4
    || proof?.offer_events !== 2 || proof?.attachments !== 1 || proof?.verifications !== 1
    || proof?.checklist_audits !== 2 || proof?.checklist_events !== 1) {
    throw new Error('Admission decision, offer, conversion, audit, or event evidence is incomplete');
  }
  process.stdout.write('Admissions encryption boundary, scoped document checklist publication, clean attachment, immutable verification, exception worklist, optional offer enforcement, applicant submission/acceptance, idempotency, decision/conversion gates, evaluator/mapper evidence, atomic canonical conversion, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
