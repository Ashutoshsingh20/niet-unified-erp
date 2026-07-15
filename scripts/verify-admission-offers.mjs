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
    throw new Error('Admission offer verification requires a _test database');
  }
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const students = new StudentsService(dataSource, policy, evidence);
  const enabledKeys = new Set(['ADMISSION_DECISION_ENABLED', 'ADMISSION_OFFER_LIFECYCLE_ENABLED']);
  const service = new AdmissionsService(dataSource, policy, evidence,
    { get: (key) => enabledKeys.has(key) }, students);
  const disabled = new AdmissionsService(dataSource, policy, evidence, { get: () => false }, students);
  const applicant = { subjectId: `offer-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const issuer = { ...applicant, subjectId: `offer-issuer-${suffix}` };
  const operator = { ...applicant, subjectId: `offer-operator-${suffix}` };
  const outsider = { ...operator, subjectId: `offer-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const governingPolicy = 'SYNTHETIC-OFFER-LIFECYCLE-POLICY';

  async function createOfferedApplication(label) {
    const created = await service.create({ applicantSubjectId: applicant.subjectId,
      programmeKey: `${label}-${suffix}`, encryptedPayloadBase64: randomBytes(64).toString('base64'),
      encryptionKeyReference: 'synthetic-offer-key-v1', payloadSha256: randomUUID().replaceAll('-', '').repeat(2),
      idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, applicant);
    await service.submit(created.id, { expectedVersion: 1,
      evidenceManifestSha256: 'a'.repeat(64) }, applicant);
    await service.decide(created.id, { outcome: 'OFFERED', evaluationEngine: 'synthetic-offer-evaluator',
      evaluationVersion: 'v1', regulationReference: governingPolicy,
      evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic lifecycle offer',
      expectedVersion: 2 }, issuer);
    return created.id;
  }

  async function issue(applicationId, label, expiresAt) {
    return service.issueOffer(applicationId, { offerReference: `${label}-${suffix}`,
      termsManifestSha256: 'b'.repeat(64), expiresAt, policyReference: governingPolicy,
      expectedApplicationVersion: 3 }, issuer);
  }

  const declineApplication = await createOfferedApplication('DECLINE');
  const declineOffer = await issue(declineApplication, 'DECLINE',
    new Date(Date.now() + 86_400_000).toISOString());
  const transition = { expectedOfferVersion: 1, reason: 'Applicant declined synthetic offer',
    policyReference: governingPolicy };
  let disabledGate = false;
  try { await disabled.declineOffer(declineOffer.id, transition, applicant); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Offer lifecycle action bypassed its disabled gate');
  let declineOwnershipDenied = false;
  try { await service.declineOffer(declineOffer.id, transition, operator); }
  catch (error) { declineOwnershipDenied = error instanceof ForbiddenException; }
  if (!declineOwnershipDenied) throw new Error('Non-applicant declined an admission offer');
  const declined = await service.declineOffer(declineOffer.id, transition, applicant);
  const declineReplay = await service.declineOffer(declineOffer.id, transition, applicant);
  if (declined.replayed || !declineReplay.replayed) throw new Error('Offer decline was not exactly idempotent');
  let changedDeclineRejected = false;
  try { await service.declineOffer(declineOffer.id, { ...transition, reason: 'Changed decline reason' }, applicant); }
  catch (error) { changedDeclineRejected = error instanceof ConflictException; }
  if (!changedDeclineRejected) throw new Error('Changed offer decline replay was accepted');

  const withdrawalApplication = await createOfferedApplication('WITHDRAW');
  let pastExpiryRejected = false;
  try { await issue(withdrawalApplication, 'INVALID-PAST', new Date(Date.now() - 1000).toISOString()); }
  catch (error) { pastExpiryRejected = error instanceof ConflictException; }
  if (!pastExpiryRejected) throw new Error('Offer was issued with a past expiry');
  const withdrawalOffer = await issue(withdrawalApplication, 'WITHDRAW',
    new Date(Date.now() + 86_400_000).toISOString());
  const withdrawal = { expectedOfferVersion: 1, reason: 'Synthetic exceptional offer withdrawal',
    policyReference: governingPolicy };
  let policyMismatchRejected = false;
  try { await service.withdrawOffer(withdrawalOffer.id,
    { ...withdrawal, policyReference: 'DIFFERENT-SYNTHETIC-POLICY' }, operator); }
  catch (error) { policyMismatchRejected = error instanceof ConflictException; }
  if (!policyMismatchRejected) throw new Error('Offer transition accepted a mismatched policy');
  let issuerWithdrawalDenied = false;
  try { await service.withdrawOffer(withdrawalOffer.id, withdrawal, issuer); }
  catch (error) { issuerWithdrawalDenied = error instanceof ForbiddenException; }
  if (!issuerWithdrawalDenied) throw new Error('Offer issuer withdrew the same offer');
  await service.withdrawOffer(withdrawalOffer.id, withdrawal, operator);
  if (!(await service.withdrawOffer(withdrawalOffer.id, withdrawal, operator)).replayed) {
    throw new Error('Offer withdrawal retry was not idempotent');
  }

  const expiryApplication = await createOfferedApplication('EXPIRY');
  const expiryOffer = await issue(expiryApplication, 'EXPIRY',
    new Date(Date.now() + 500).toISOString());
  const expiration = { expectedOfferVersion: 1, reason: 'Configured synthetic offer expiry reached',
    policyReference: governingPolicy };
  const due = await service.listOfferExceptions({ scopeType: 'organization', scopeId,
    dueBefore: new Date(Date.now() + 60_000).toISOString(), limit: 50 }, operator);
  if (!due.items.some((item) => item.offerId === expiryOffer.id)) {
    throw new Error('Upcoming offer was absent from the expiry worklist');
  }
  let worklistScopeDenied = false;
  try { await service.listOfferExceptions({ scopeType: 'organization', scopeId,
    dueBefore: new Date(Date.now() + 60_000).toISOString(), limit: 50 }, outsider); }
  catch (error) { worklistScopeDenied = error instanceof ForbiddenException; }
  if (!worklistScopeDenied) throw new Error('Offer expiry worklist ignored tenant scope');
  let earlyExpiryRejected = false;
  try { await service.expireOffer(expiryOffer.id, expiration, operator); }
  catch (error) { earlyExpiryRejected = error instanceof ConflictException; }
  if (!earlyExpiryRejected) throw new Error('Offer expired before its configured instant');
  await new Promise((resolve) => setTimeout(resolve, 600));
  let lateAcceptanceRejected = false;
  try { await service.acceptOffer(expiryOffer.id, { expectedOfferVersion: 1 }, applicant); }
  catch (error) { lateAcceptanceRejected = error instanceof ConflictException; }
  if (!lateAcceptanceRejected) throw new Error('Expired offer was accepted');
  let issuerExpirationDenied = false;
  try { await service.expireOffer(expiryOffer.id, expiration, issuer); }
  catch (error) { issuerExpirationDenied = error instanceof ForbiddenException; }
  if (!issuerExpirationDenied) throw new Error('Offer issuer expired the same offer');
  await service.expireOffer(expiryOffer.id, expiration, operator);
  if (!(await service.expireOffer(expiryOffer.id, expiration, operator)).replayed) {
    throw new Error('Offer expiration retry was not idempotent');
  }
  const afterExpiry = await service.listOfferExceptions({ scopeType: 'organization', scopeId,
    dueBefore: new Date(Date.now() + 60_000).toISOString(), limit: 50 }, operator);
  if (afterExpiry.items.some((item) => item.offerId === expiryOffer.id)) {
    throw new Error('Terminal offer remained in the expiry worklist');
  }

  const guardApplication = await createOfferedApplication('DATABASE-GUARD');
  const guardOffer = await issue(guardApplication, 'DATABASE-GUARD',
    new Date(Date.now() + 86_400_000).toISOString());
  let evidenceBypassRejected = false;
  try { await dataSource.query(
    "UPDATE admissions.offers SET status='WITHDRAWN',version=version+1 WHERE id=$1", [guardOffer.id]); }
  catch { evidenceBypassRejected = true; }
  if (!evidenceBypassRejected) throw new Error('Terminal offer state bypassed lifecycle evidence');
  let applicationMismatchRejected = false;
  try { await dataSource.query(`INSERT INTO admissions.offer_lifecycle_events
    (id,offer_id,application_id,transition,from_status,to_status,reason,policy_reference,acted_by)
    VALUES ($1,$2,$3,'WITHDRAWN','ISSUED','WITHDRAWN',$4,$5,$6)`,
  [randomUUID(), guardOffer.id, declineApplication, 'Synthetic mismatched application evidence',
    governingPolicy, operator.subjectId]); } catch { applicationMismatchRejected = true; }
  if (!applicationMismatchRejected) throw new Error('Lifecycle evidence accepted a mismatched application');
  let eventMutationRejected = false;
  try { await dataSource.query("UPDATE admissions.offer_lifecycle_events SET reason='tampered'"); }
  catch { eventMutationRejected = true; }
  if (!eventMutationRejected) throw new Error('Offer lifecycle evidence was mutable');
  const proofRows = await dataSource.query(`SELECT
    (SELECT array_agg(status ORDER BY offer_reference) FROM admissions.offers
      WHERE id=ANY($1::uuid[])) statuses,
    (SELECT count(*)::int FROM admissions.applications
      WHERE id=ANY($2::uuid[]) AND status='WITHDRAWN') withdrawn_applications,
    (SELECT count(*)::int FROM admissions.offer_lifecycle_events
      WHERE offer_id=ANY($1::uuid[])) lifecycle_events,
    (SELECT count(*)::int FROM platform.audit_events
      WHERE resource_type='admission-offer' AND resource_id=ANY($3::text[])) audits,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type='admission-offer' AND aggregate_id=ANY($3::text[])) outbox_events`,
  [[declineOffer.id, withdrawalOffer.id, expiryOffer.id],
    [declineApplication, withdrawalApplication, expiryApplication],
    [declineOffer.id, withdrawalOffer.id, expiryOffer.id]]);
  const proof = proofRows[0];
  if (JSON.stringify(proof?.statuses) !== JSON.stringify(['DECLINED', 'EXPIRED', 'WITHDRAWN'])
    || proof?.withdrawn_applications !== 3 || proof?.lifecycle_events !== 3
    || proof?.audits !== 6 || proof?.outbox_events !== 6) {
    throw new Error('Offer lifecycle state, audit, or outbox evidence is incomplete');
  }
  process.stdout.write('Admission offer future-dated issuance, applicant decline, maker-checker withdrawal, expiry worklist, late-acceptance rejection, exact replay, scope, immutable evidence, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}
