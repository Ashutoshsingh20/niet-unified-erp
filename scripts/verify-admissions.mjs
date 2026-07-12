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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Admissions verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const students = new StudentsService(dataSource, policy, evidence);
  const enabled = new AdmissionsService(dataSource, policy, evidence, { get: () => true }, students);
  const disabled = new AdmissionsService(dataSource, policy, evidence, { get: () => false }, students);
  const applicant = { subjectId: `applicant-${suffix}`, assuranceLevel: 2, permissions: new Set(), scopes: { organization: [scopeId] } };
  const reviewer = { ...applicant, subjectId: `reviewer-${suffix}` };
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
  const decision = { outcome: 'OFFERED', evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
    regulationReference: 'SYNTHETIC-VERIFICATION-ONLY', evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' },
    reason: 'Synthetic evaluator offer', expectedVersion: 2 };
  let disabledGate = false;
  try { await disabled.decide(created.id, decision, reviewer); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Admission decision bypassed disabled gate');
  await enabled.decide(created.id, decision, reviewer);
  const offer = await enabled.issueOffer(created.id, { offerReference: `OFFER-${suffix}`,
    termsManifestSha256: 'd'.repeat(64), expectedApplicationVersion: 3 }, reviewer);
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
  const rows = await dataSource.query(`SELECT a.status,a.version,d.evaluation_engine,d.regulation_reference,
    o.status offer_status,o.version offer_version,c.mapping_engine,c.mapping_version,
    s.status student_status,s.source_system,s.source_key,s.source_row_sha256,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-application' AND resource_id=a.id::text) audits,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-offer' AND resource_id=o.id::text) offer_audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-application'
      AND aggregate_id=a.id::text) application_events,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-offer'
      AND aggregate_id=o.id::text) offer_events
    FROM admissions.applications a JOIN admissions.decisions d ON d.application_id=a.id
    JOIN admissions.offers o ON o.application_id=a.id JOIN admissions.conversions c ON c.application_id=a.id
    JOIN student.records s ON s.id=c.student_id WHERE a.id=$1`, [created.id]);
  const proof = rows[0];
  if (proof?.status !== 'CONVERTED' || proof?.version !== 4 || proof?.evaluation_engine !== 'synthetic-evaluator'
    || proof?.regulation_reference !== 'SYNTHETIC-VERIFICATION-ONLY' || proof?.offer_status !== 'ACCEPTED'
    || proof?.offer_version !== 2 || proof?.mapping_engine !== 'synthetic-mapper' || proof?.mapping_version !== 'v1'
    || proof?.student_status !== 'PROVISIONAL' || proof?.source_system !== 'admissions'
    || proof?.source_key !== created.id || proof?.source_row_sha256 !== input.payloadSha256
    || proof?.audits !== 4 || proof?.offer_audits !== 2 || proof?.application_events !== 3
    || proof?.offer_events !== 2) {
    throw new Error('Admission decision, offer, conversion, audit, or event evidence is incomplete');
  }
  process.stdout.write('Admissions encryption boundary, scope, applicant submission/acceptance, idempotency, disabled decision/conversion gates, evaluator/mapper evidence, atomic canonical conversion, immutable history, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
