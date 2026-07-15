import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();

try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Admission cancellation verification requires a _test database');
  }
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const students = new StudentsService(dataSource, policy, evidence);
  const enabledKeys = new Set(['ADMISSION_DECISION_ENABLED', 'ADMISSION_CANCELLATION_ENABLED',
    'STUDENT_CONVERSION_ENABLED']);
  const service = new AdmissionsService(dataSource, policy, evidence,
    { get: (key) => enabledKeys.has(key) }, students);
  const disabled = new AdmissionsService(dataSource, policy, evidence, { get: () => false }, students);
  const applicant = { subjectId: `cancellation-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const assessor = { ...applicant, subjectId: `cancellation-assessor-${suffix}` };
  const outsider = { ...assessor, subjectId: `cancellation-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const cancellationPolicy = 'SYNTHETIC-CANCELLATION-ASSESSMENT-POLICY';

  async function createAcceptedOffer(label) {
    const application = await service.create({ applicantSubjectId: applicant.subjectId,
      programmeKey: `${label}-${suffix}`, encryptedPayloadBase64: randomBytes(64).toString('base64'),
      encryptionKeyReference: 'synthetic-cancellation-key-v1',
      payloadSha256: randomUUID().replaceAll('-', '').repeat(2), idempotencyKey: randomUUID(),
      scopeType: 'organization', scopeId }, applicant);
    await service.submit(application.id, { expectedVersion: 1,
      evidenceManifestSha256: 'a'.repeat(64) }, applicant);
    await service.decide(application.id, { outcome: 'OFFERED',
      evaluationEngine: 'synthetic-cancellation-eligibility', evaluationVersion: 'v1',
      regulationReference: cancellationPolicy, evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' },
      reason: 'Synthetic cancellation journey offer', expectedVersion: 2 }, assessor);
    const offer = await service.issueOffer(application.id, { offerReference: `${label}-${suffix}`,
      termsManifestSha256: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      policyReference: cancellationPolicy, expectedApplicationVersion: 3 }, assessor);
    await service.acceptOffer(offer.id, { expectedOfferVersion: 1 }, applicant);
    return { applicationId: application.id, offerId: offer.id };
  }

  function assessment(decision, financialDisposition, reason) {
    return { expectedRequestVersion: 1, decision, financialDisposition,
      evaluationEngine: 'synthetic-cancellation-assessor', evaluationVersion: 'v1',
      policyReference: cancellationPolicy, evaluationTrace: { result: financialDisposition }, reason };
  }

  const noRefund = await createAcceptedOffer('NO-REFUND');
  const noRefundRequestInput = { idempotencyKey: randomUUID(), expectedOfferVersion: 2,
    reason: 'Applicant requests synthetic no-refund cancellation' };
  let disabledGate = false;
  try { await disabled.requestCancellation(noRefund.offerId, noRefundRequestInput, applicant); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Admission cancellation bypassed its disabled gate');
  let ownershipDenied = false;
  try { await service.requestCancellation(noRefund.offerId, noRefundRequestInput, assessor); }
  catch (error) { ownershipDenied = error instanceof ForbiddenException; }
  if (!ownershipDenied) throw new Error('Non-applicant requested admission cancellation');
  const noRefundRequest = await service.requestCancellation(noRefund.offerId, noRefundRequestInput, applicant);
  const noRefundReplay = await service.requestCancellation(noRefund.offerId, noRefundRequestInput, applicant);
  if (!noRefundReplay.replayed || noRefundReplay.id !== noRefundRequest.id) {
    throw new Error('Cancellation request retry was not idempotent');
  }
  let changedRequestRejected = false;
  try { await service.requestCancellation(noRefund.offerId,
    { ...noRefundRequestInput, reason: 'Changed cancellation reason' }, applicant); }
  catch (error) { changedRequestRejected = error instanceof ConflictException; }
  if (!changedRequestRejected) throw new Error('Changed cancellation request replay was accepted');
  const noRefundAssessment = assessment('APPROVED', 'NO_REFUND_REQUIRED',
    'Synthetic evidence proves no refundable payment');
  let makerDenied = false;
  try { await service.assessCancellation(noRefundRequest.id, noRefundAssessment, applicant); }
  catch (error) { makerDenied = error instanceof ForbiddenException; }
  if (!makerDenied) throw new Error('Cancellation requester assessed the same request');
  let invalidDispositionRejected = false;
  try { await service.assessCancellation(noRefundRequest.id,
    assessment('REJECTED', 'NO_REFUND_REQUIRED', 'Invalid synthetic disposition'), assessor); }
  catch (error) { invalidDispositionRejected = error instanceof ConflictException; }
  if (!invalidDispositionRejected) throw new Error('Cancellation accepted an inconsistent disposition');
  const cancelled = await service.assessCancellation(noRefundRequest.id, noRefundAssessment, assessor);
  const cancelledReplay = await service.assessCancellation(noRefundRequest.id, noRefundAssessment, assessor);
  if (cancelled.status !== 'CANCELLED' || cancelled.replayed || !cancelledReplay.replayed) {
    throw new Error('No-refund cancellation assessment did not complete idempotently');
  }

  const financeReview = await createAcceptedOffer('FINANCE-REVIEW');
  const financeRequest = await service.requestCancellation(financeReview.offerId,
    { idempotencyKey: randomUUID(), expectedOfferVersion: 2,
      reason: 'Applicant requests cancellation requiring finance review' }, applicant);
  const financeAssessment = assessment('APPROVED', 'FINANCE_REVIEW_REQUIRED',
    'Synthetic assessment requires governed finance review');
  const pending = await service.assessCancellation(financeRequest.id, financeAssessment, assessor);
  if (pending.status !== 'PENDING_FINANCE') throw new Error('Finance review cancellation was closed prematurely');
  const exceptions = await service.listCancellationExceptions({ scopeType: 'organization', scopeId,
    limit: 50 }, assessor);
  if (!exceptions.items.some((item) => item.cancellationRequestId === financeRequest.id
    && item.policyReference === cancellationPolicy)) {
    throw new Error('Finance-review cancellation was absent from the scoped worklist');
  }
  let exceptionScopeDenied = false;
  try { await service.listCancellationExceptions({ scopeType: 'organization', scopeId, limit: 50 }, outsider); }
  catch (error) { exceptionScopeDenied = error instanceof ForbiddenException; }
  if (!exceptionScopeDenied) throw new Error('Cancellation finance worklist ignored tenant scope');
  let conversionBlocked = false;
  try { await service.convert(financeReview.offerId, { idempotencyKey: randomUUID(),
    displayName: 'Should Not Convert', mappingEngine: 'synthetic-mapper', mappingVersion: 'v1',
    mappingTrace: { result: 'BLOCKED' }, expectedOfferVersion: 2 }, assessor); }
  catch (error) { conversionBlocked = error instanceof ConflictException; }
  if (!conversionBlocked) throw new Error('Active finance-review cancellation allowed conversion');

  const rejected = await createAcceptedOffer('REJECTED');
  const rejectedRequest = await service.requestCancellation(rejected.offerId,
    { idempotencyKey: randomUUID(), expectedOfferVersion: 2,
      reason: 'Applicant requests synthetic rejected cancellation' }, applicant);
  const rejectedResult = await service.assessCancellation(rejectedRequest.id,
    assessment('REJECTED', 'NOT_APPLICABLE', 'Synthetic policy evidence rejects cancellation'), assessor);
  if (rejectedResult.status !== 'REJECTED') throw new Error('Rejected cancellation changed offer state');

  const converted = await createAcceptedOffer('CONVERTED');
  await service.convert(converted.offerId, { idempotencyKey: randomUUID(),
    displayName: 'Synthetic Converted Cancellation Student', mappingEngine: 'synthetic-mapper',
    mappingVersion: 'v1', mappingTrace: { result: 'SYNTHETIC_MAPPING' },
    expectedOfferVersion: 2 }, assessor);
  let convertedCancellationBlocked = false;
  try { await service.requestCancellation(converted.offerId, { idempotencyKey: randomUUID(),
    expectedOfferVersion: 2, reason: 'Invalid post-conversion cancellation request' }, applicant); }
  catch (error) { convertedCancellationBlocked = error instanceof ConflictException; }
  if (!convertedCancellationBlocked) throw new Error('Converted admission bypassed student withdrawal workflow');

  const guard = await createAcceptedOffer('DATABASE-GUARD');
  let cancellationBypassRejected = false;
  try { await dataSource.query(
    "UPDATE admissions.offers SET status='CANCELLED',version=version+1 WHERE id=$1", [guard.offerId]); }
  catch { cancellationBypassRejected = true; }
  if (!cancellationBypassRejected) throw new Error('Accepted offer cancelled without assessment evidence');
  let assessmentMutationRejected = false;
  try { await dataSource.query("UPDATE admissions.cancellation_assessments SET reason='tampered'"); }
  catch { assessmentMutationRejected = true; }
  if (!assessmentMutationRejected) throw new Error('Cancellation assessment evidence was mutable');

  const proofRows = await dataSource.query(`SELECT
    (SELECT array_agg(status ORDER BY id) FROM admissions.cancellation_requests
      WHERE id=ANY($1::uuid[])) request_statuses,
    (SELECT count(*)::int FROM admissions.cancellation_assessments
      WHERE request_id=ANY($1::uuid[])) assessments,
    (SELECT count(*)::int FROM platform.audit_events
      WHERE resource_type='admission-cancellation-request' AND resource_id=ANY($2::text[])) audits,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type='admission-cancellation-request' AND aggregate_id=ANY($2::text[])) events,
    (SELECT status FROM admissions.offers WHERE id=$3) cancelled_offer_status,
    (SELECT status FROM admissions.applications WHERE id=$4) cancelled_application_status`,
  [[noRefundRequest.id, financeRequest.id, rejectedRequest.id],
    [noRefundRequest.id, financeRequest.id, rejectedRequest.id], noRefund.offerId, noRefund.applicationId]);
  const proof = proofRows[0];
  const statuses = [...(proof?.request_statuses ?? [])].sort();
  if (JSON.stringify(statuses) !== JSON.stringify(['CANCELLED', 'PENDING_FINANCE', 'REJECTED'])
    || proof?.assessments !== 3 || proof?.audits !== 6 || proof?.events !== 6
    || proof?.cancelled_offer_status !== 'CANCELLED'
    || proof?.cancelled_application_status !== 'WITHDRAWN') {
    throw new Error('Cancellation state, assessment, audit, or event evidence is incomplete');
  }
  process.stdout.write('Admission cancellation ownership, exact replay, explainable no-refund completion, finance-review handoff/worklist, conversion block, post-conversion fail-closed boundary, maker-checker, scope, immutable evidence, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}
