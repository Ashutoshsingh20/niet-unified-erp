import { randomBytes, randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { AttendanceService } from '../apps/api/dist/modules/attendance/attendance.service.js';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { DocumentsService } from '../apps/api/dist/modules/documents/documents.service.js';
import { FinanceService } from '../apps/api/dist/modules/finance/finance.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentCoreService } from '../apps/api/dist/modules/student-core/student-core.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { TimetableService } from '../apps/api/dist/modules/timetable/timetable.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

class JourneyObjectStorage {
  metadata;
  async createQuarantineUpload(input) {
    this.metadata = { sizeBytes: 128, contentType: input.contentType, sha256: input.sha256 };
    return { url: 'http://storage.invalid/journey-upload',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      requiredHeaders: { 'content-type': input.contentType } };
  }
  async headQuarantineObject() {
    if (this.metadata === undefined) throw new Error('No synthetic journey document');
    return this.metadata;
  }
  async promoteToClean() {}
  async createCleanDownload() { return 'http://storage.invalid/journey-download'; }
}
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Student-core verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const config = { get: (key) => key !== 'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED' };
  const admissionsKeys = new Set(['ADMISSION_DOCUMENT_CHECKLIST_ENABLED',
    'ADMISSION_DOCUMENT_VERIFICATION_ENABLED', 'ADMISSION_DOCUMENT_ENFORCEMENT_ENABLED',
    'ADMISSION_DECISION_ENABLED', 'STUDENT_CONVERSION_ENABLED']);
  const admissionsConfig = { get: (key) => admissionsKeys.has(key) };
  const students = new StudentsService(dataSource, policy, evidence);
  const admissions = new AdmissionsService(dataSource, policy, evidence, admissionsConfig, students);
  const documents = new DocumentsService(dataSource, policy, evidence, new JourneyObjectStorage());
  const curriculum = new CurriculumService(dataSource, policy, evidence, config);
  const registration = new RegistrationService(dataSource, policy, evidence, config);
  const timetable = new TimetableService(dataSource, policy, evidence, config);
  const attendance = new AttendanceService(dataSource, policy, evidence, config);
  const finance = new FinanceService(dataSource, policy, evidence, config);
  const core = new StudentCoreService(dataSource, policy);
  const applicant = { subjectId: `journey-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const operator = { ...applicant, subjectId: `journey-operator-${suffix}` };
  const approver = { ...applicant, subjectId: `journey-approver-${suffix}` };
  const application = await admissions.create({ applicantSubjectId: applicant.subjectId,
    programmeKey: `PROGRAMME-${suffix}`, encryptedPayloadBase64: randomBytes(64).toString('base64'),
    encryptionKeyReference: 'synthetic-key-v1', payloadSha256: '6'.repeat(64),
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, applicant);
  await admissions.submit(application.id, { expectedVersion: 1,
    evidenceManifestSha256: '7'.repeat(64) }, applicant);
  const documentTypeKey = `journey.identity-${suffix}`;
  const documentType = await documents.createType({ typeKey: documentTypeKey, version: 1,
    title: 'Synthetic integrated journey identity evidence', allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 1024, classification: 'RESTRICTED', retentionDays: 30 }, operator);
  await documents.publishType(documentType.id, operator);
  const documentSha = '5'.repeat(64);
  const upload = await documents.initiateUpload({ documentTypeKey, filename: 'journey-identity.pdf',
    mimeType: 'application/pdf', sizeBytes: 128, sha256: documentSha,
    scopeType: 'organization', scopeId }, applicant);
  await documents.completeUpload(upload.documentId, applicant);
  await documents.recordScan(upload.documentId, { outcome: 'CLEAN', scannerEngine: 'synthetic-av',
    signatureVersion: 'v1', detectedMimeType: 'application/pdf', computedSha256: documentSha,
    reason: 'Synthetic integrated journey document is clean' }, operator);
  await documents.promote(upload.documentId, operator);
  const checklist = await admissions.createDocumentChecklist(application.id, {
    idempotencyKey: randomUUID(), policyReference: 'SYNTHETIC-INTEGRATED-DOCUMENT-POLICY',
    expectedApplicationVersion: 2, items: [{ requirementKey: 'identity-proof',
      title: 'Identity proof', documentTypeKey, required: true }] }, operator);
  await admissions.publishDocumentChecklist(checklist.id, { expectedChecklistVersion: 1 }, approver);
  const checklistItems = await dataSource.query(
    'SELECT id FROM admissions.document_checklist_items WHERE checklist_id=$1', [checklist.id]);
  const checklistItemId = checklistItems[0]?.id;
  if (checklistItemId === undefined) throw new Error('Integrated journey checklist item is missing');
  const attachment = await admissions.attachDocument(checklistItemId,
    { documentId: upload.documentId }, applicant);
  const verification = await admissions.verifyDocument(attachment.id, {
    outcome: 'VERIFIED', verificationEngine: 'synthetic-journey-verifier',
    verificationVersion: 'v1', verificationTrace: { result: 'SYNTHETIC_MATCH' },
    evidenceSha256: '4'.repeat(64), reason: 'Synthetic integrated identity evidence matched' }, operator);
  if (!verification.checklistComplete) throw new Error('Integrated admission document checklist is incomplete');
  await admissions.decide(application.id, { outcome: 'OFFERED', evaluationEngine: 'synthetic-evaluator',
    evaluationVersion: 'v1', regulationReference: 'SYNTHETIC-VERIFICATION-ONLY',
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic journey offer',
    expectedVersion: 2 }, operator);
  const offer = await admissions.issueOffer(application.id, { offerReference: `JOURNEY-${suffix}`,
    termsManifestSha256: '8'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference: 'SYNTHETIC-INTEGRATED-JOURNEY-OFFER-POLICY', expectedApplicationVersion: 3 }, operator);
  await admissions.acceptOffer(offer.id, { expectedOfferVersion: 1 }, applicant);
  const conversion = await admissions.convert(offer.id, { idempotencyKey: randomUUID(),
    displayName: 'Synthetic Journey Student', mappingEngine: 'synthetic-mapper', mappingVersion: 'v1',
    mappingTrace: { result: 'SYNTHETIC_MAPPING' }, expectedOfferVersion: 2 }, operator);
  const regulation = await curriculum.create({ regulationKey: `journey-${suffix}`, version: 1,
    title: 'Synthetic journey regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_ACCEPT_ALL' },
    impactSummary: 'Synthetic rule for integrated student-core verification.' }, operator);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, operator);
  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `journey-${suffix}`, version: 1,
    title: 'Synthetic journey period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, operator);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, operator);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `SECTION-${suffix}`, courseKey: `COURSE-${suffix}`, title: 'Synthetic journey course',
    capacity: 1, scopeType: 'organization', scopeId }, operator);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, operator);
  const request = await registration.submit({ studentId: conversion.studentId, periodId: period.id,
    offeringIds: [offering.id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, applicant);
  await registration.decide(request.id, { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic journey confirmation',
    expectedVersion: 1 }, operator);
  const meeting = await timetable.create({ offeringId: offering.id, meetingKey: `MEETING-${suffix}`,
    weekday: 2, startMinute: 600, endMinute: 660, roomKey: `ROOM-${suffix}`,
    instructorSubjectId: `INSTRUCTOR-${suffix}`, scopeType: 'organization', scopeId }, operator);
  await timetable.publish(meeting.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, operator);
  const session = await attendance.createSession({ offeringId: offering.id, sessionKey: `SESSION-${suffix}`,
    startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(),
    scopeType: 'organization', scopeId }, operator);
  await attendance.openSession(session.id, { expectedVersion: 1 }, operator);
  await attendance.recordObservation(session.id, { studentId: conversion.studentId,
    presenceState: 'OBSERVED_PRESENT', sourceKind: 'synthetic-verifier', observedAt: new Date().toISOString(),
    evidence: { synthetic: true } }, operator);
  await attendance.finalize(session.id, { expectedVersion: 2,
    reason: 'Synthetic integrated journey completion' }, operator);
  const account = await finance.createAccount({ studentId: conversion.studentId, currency: 'INR',
    scopeType: 'organization', scopeId }, operator);
  await finance.post({ accountId: account.id, amountMinor: '10000', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-DEMAND-${suffix}` }, 'DEMAND', operator);
  await finance.post({ accountId: account.id, amountMinor: '2500', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: `SYNTHETIC-PAYMENT-${suffix}` }, 'PAYMENT', operator);
  const overview = await core.overview(applicant);
  if (overview.student.id !== conversion.studentId || overview.student.status !== 'PROVISIONAL'
    || overview.registrations.length !== 1 || overview.registrations[0]?.offeringId !== offering.id
    || overview.schedule.length !== 1 || overview.schedule[0]?.meetingId !== meeting.id
    || overview.attendance.length !== 1 || overview.attendance[0]?.presenceState !== 'OBSERVED_PRESENT'
    || overview.accounts.length !== 1 || overview.accounts[0]?.balanceMinor !== '7500') {
    throw new Error('Integrated student-core overview did not reconcile authoritative domains');
  }
  let wrongScopeDenied = false;
  try { await core.overview({ ...applicant, scopes: { organization: [randomUUID()] } }); }
  catch (error) { wrongScopeDenied = error instanceof ForbiddenException; }
  if (!wrongScopeDenied) throw new Error('Student-core overview ignored scope');
  let wrongIdentityDenied = false;
  try { await core.overview({ ...applicant, subjectId: `other-${suffix}` }); }
  catch (error) { wrongIdentityDenied = error instanceof NotFoundException; }
  if (!wrongIdentityDenied) throw new Error('Student-core overview exposed another identity');
  process.stdout.write('Integrated clean admission document verification, offer conversion, registration, published timetable, finalized attendance, derived fee balance, self identity, and scope denial verified\n');
} finally { await dataSource.destroy(); }
