import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { ConversionExceptionsService } from '../apps/api/dist/modules/admissions/conversion-exceptions.service.js';
import { FinanceService } from '../apps/api/dist/modules/finance/finance.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Conversion exception verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const admissionKeys = new Set(['ADMISSION_DECISION_ENABLED', 'ADMISSION_OFFER_LIFECYCLE_ENABLED',
    'STUDENT_CONVERSION_ENABLED']); const config = { get: (key) => admissionKeys.has(key) };
  const students = new StudentsService(dataSource, policy, evidence);
  const admissions = new AdmissionsService(dataSource, policy, evidence, config, students);
  const finance = new FinanceService(dataSource, policy, evidence,
    { get: (key) => ['ADMISSION_FINANCE_ACCOUNT_ENABLED'].includes(key) });
  const enabledExceptions = new ConversionExceptionsService(dataSource, policy, evidence,
    { get: (key) => ['ADMISSION_CONVERSION_EXCEPTION_RESOLUTION_ENABLED',
      'ADMISSION_CONVERSION_EXCEPTION_WAIVER_ENABLED'].includes(key) });
  const noWaiver = new ConversionExceptionsService(dataSource, policy, evidence,
    { get: (key) => key === 'ADMISSION_CONVERSION_EXCEPTION_RESOLUTION_ENABLED' });
  const disabledExceptions = new ConversionExceptionsService(dataSource, policy, evidence, { get: () => false });
  const applicant = { subjectId: `conversion-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const converter = { ...applicant, subjectId: `conversion-actor-${suffix}` };
  const detector = { ...applicant, subjectId: `conversion-detector-${suffix}` };
  const resolver = { ...applicant, subjectId: `conversion-resolver-${suffix}` };
  const outsider = { ...resolver, subjectId: `conversion-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const policyReference = 'SYNTHETIC-CONVERSION-RECONCILIATION';
  const application = await admissions.create({ applicantSubjectId: applicant.subjectId,
    programmeKey: `CONVERSION-PROGRAMME-${suffix}`,
    encryptedPayloadBase64: randomBytes(64).toString('base64'),
    encryptionKeyReference: 'synthetic-conversion-key', payloadSha256: 'a'.repeat(64),
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, applicant);
  await admissions.submit(application.id, { expectedVersion: 1, evidenceManifestSha256: 'b'.repeat(64) }, applicant);
  await admissions.decide(application.id, { outcome: 'OFFERED', evaluationEngine: 'synthetic-eligibility',
    evaluationVersion: 'v1', regulationReference: policyReference,
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic conversion eligibility',
    expectedVersion: 2 }, converter);
  const account = await finance.createApplicantAccount({ applicationId: application.id, currency: 'INR',
    policyReference, idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, converter);
  const offer = await admissions.issueOffer(application.id, { offerReference: `CONVERT-${suffix}`,
    termsManifestSha256: 'c'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference, expectedApplicationVersion: 3 }, converter);
  await admissions.acceptOffer(offer.id, { expectedOfferVersion: 1 }, applicant);
  const converted = await admissions.convert(offer.id, { idempotencyKey: randomUUID(),
    displayName: 'Synthetic Reconciliation Student', mappingEngine: 'synthetic-mapper',
    mappingVersion: 'v1', mappingTrace: { result: 'SYNTHETIC_MAPPING' }, expectedOfferVersion: 2 }, converter);
  const conversionRows = await dataSource.query(`SELECT id FROM admissions.conversions WHERE student_id=$1`,
    [converted.studentId]); const conversionId = conversionRows[0].id;

  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL session_replication_role='replica'");
    await manager.query('DELETE FROM finance.account_student_links WHERE account_id=$1', [account.id]);
  });
  const scan = await enabledExceptions.scan({ scopeType: 'organization', scopeId, limit: 100 }, detector);
  if (scan.scanned !== 1 || scan.discovered !== 1 || scan.open !== 1) {
    throw new Error('Finance continuity exception was not detected exactly once');
  }
  const repeated = await enabledExceptions.scan({ scopeType: 'organization', scopeId, limit: 100 }, detector);
  if (repeated.discovered !== 0 || repeated.open !== 1) throw new Error('Exception scan was not idempotent');
  let scopeDenied = false;
  try { await enabledExceptions.list({ scopeType: 'organization', scopeId, limit: 50 }, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Conversion exception worklist ignored scope');
  const open = await enabledExceptions.list({ scopeType: 'organization', scopeId, status: 'OPEN', limit: 50 }, resolver);
  const financeCase = open.items.find((item) => item.issueCode === 'FINANCE_LINK_MISSING');
  if (financeCase === undefined || financeCase.details.applicantAccountCount !== 1
    || financeCase.details.linkedAccountCount !== 0) throw new Error('Finance exception details are not actionable');
  const resolution = { expectedVersion: 1, outcome: 'RESOLVED', evaluationEngine: 'synthetic-reconciler',
    evaluationVersion: 'v1', policyReference, evaluationTrace: { check: 'SYNTHETIC_FINANCE_LINK' },
    reason: 'Synthetic finance continuity was restored' };
  let disabledRejected = false;
  try { await disabledExceptions.resolve(financeCase.id, resolution, resolver); }
  catch (error) { disabledRejected = error instanceof ForbiddenException; }
  if (!disabledRejected) throw new Error('Resolution bypassed disabled gate');
  let detectorRejected = false;
  try { await enabledExceptions.resolve(financeCase.id, resolution, detector); }
  catch (error) { detectorRejected = error instanceof ForbiddenException; }
  if (!detectorRejected) throw new Error('Detector resolved the same conversion exception');
  let falseResolutionRejected = false;
  try { await enabledExceptions.resolve(financeCase.id, resolution, resolver); }
  catch (error) { falseResolutionRejected = error instanceof ConflictException; }
  if (!falseResolutionRejected) throw new Error('Failing invariant was falsely marked resolved');
  await dataSource.query(`INSERT INTO finance.account_student_links
    (id,account_id,application_id,student_id,conversion_id,linked_by) VALUES ($1,$2,$3,$4,$5,$6)`,
  [randomUUID(), account.id, application.id, converted.studentId, conversionId, converter.subjectId]);
  const resolved = await enabledExceptions.resolve(financeCase.id, resolution, resolver);
  if (resolved.status !== 'RESOLVED' || resolved.replayed) throw new Error('Repaired invariant did not resolve');
  if (!(await enabledExceptions.resolve(financeCase.id, resolution, resolver)).replayed) {
    throw new Error('Conversion exception resolution replay failed');
  }

  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL session_replication_role='replica'");
    await manager.query("UPDATE admissions.applications SET status='OFFERED' WHERE id=$1", [application.id]);
  });
  const secondScan = await enabledExceptions.scan({ scopeType: 'organization', scopeId, limit: 100 }, detector);
  if (secondScan.discovered !== 1 || secondScan.open !== 1) throw new Error('Application-state exception was not detected');
  const stateCase = (await enabledExceptions.list({ scopeType: 'organization', scopeId,
    status: 'OPEN', limit: 50 }, resolver)).items[0];
  if (stateCase?.issueCode !== 'APPLICATION_STATE_MISMATCH') throw new Error('Wrong conversion exception detected');
  const waiver = { ...resolution, outcome: 'WAIVED', reason: 'Synthetic policy-approved legacy exception waiver',
    evaluationTrace: { approval: 'SYNTHETIC_WAIVER' } };
  let waiverGateRejected = false;
  try { await noWaiver.resolve(stateCase.id, waiver, resolver); }
  catch (error) { waiverGateRejected = error instanceof ForbiddenException; }
  if (!waiverGateRejected) throw new Error('Waiver bypassed its separate policy gate');
  if ((await enabledExceptions.resolve(stateCase.id, waiver, resolver)).status !== 'WAIVED') {
    throw new Error('Governed conversion exception waiver failed');
  }
  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL session_replication_role='replica'");
    await manager.query("UPDATE admissions.applications SET status='CONVERTED' WHERE id=$1", [application.id]);
  });
  let directTransitionRejected = false;
  try { await dataSource.query("UPDATE admissions.conversion_exception_cases SET status='WAIVED',version=version+1 WHERE id=$1",
    [financeCase.id]); } catch { directTransitionRejected = true; }
  if (!directTransitionRejected) throw new Error('Conversion exception status bypassed resolution evidence');
  const proofRows = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM admissions.conversion_exception_cases WHERE conversion_id=$1) cases,
    (SELECT count(*)::int FROM admissions.conversion_exception_resolutions r
      JOIN admissions.conversion_exception_cases c ON c.id=r.case_id WHERE c.conversion_id=$1) resolutions,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type='admission-conversion-exception') events`, [conversionId]);
  if (proofRows[0]?.cases !== 2 || proofRows[0]?.resolutions !== 2 || proofRows[0]?.events < 4) {
    throw new Error('Conversion exception evidence, audit, or events are incomplete');
  }
  process.stdout.write('Scoped conversion reconciliation, durable idempotent detection, finance continuity repair proof, false-resolution rejection, maker-checker closure, separately gated waiver, immutable evidence, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
