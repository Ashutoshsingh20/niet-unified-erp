import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();

try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Registration verification requires _test');
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: () => true };
  const disabledConfig = { get: () => false };
  const registration = new RegistrationService(dataSource, policy, evidence, enabledConfig);
  const disabled = new RegistrationService(dataSource, policy, evidence, disabledConfig);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabledConfig);
  const students = new StudentsService(dataSource, policy, evidence);
  const owner = { subjectId: `registration-owner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const promoter = { ...owner, subjectId: `registration-promoter-${suffix}` };
  const studentInput = (number) => ({ idempotencyKey: randomUUID(),
    subjectId: `registration-student-${suffix}-${number}`, displayName: `Synthetic Student ${number}`,
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-admissions',
    sourceKey: `registration-application-${suffix}-${number}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: String(number).repeat(64) });
  const student1 = await students.create(studentInput(1), owner);
  const student2 = await students.create(studentInput(2), owner);
  const student3 = await students.create(studentInput(3), owner);
  const student4 = await students.create(studentInput(4), owner);
  const regulation = await curriculum.create({ regulationKey: `synthetic.registration-${suffix}`, version: 1,
    title: 'Synthetic registration regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_ACCEPT_ALL' },
    impactSummary: 'Synthetic registration rule used only for capacity and evidence verification.' }, owner);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `synthetic-period-${suffix}`, version: 1,
    title: 'Synthetic registration period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, owner);
  let publicationDisabled = false;
  try {
    await disabled.publishPeriod(period.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  } catch (error) { publicationDisabled = error instanceof ForbiddenException; }
  if (!publicationDisabled) throw new Error('Academic period publication bypassed its disabled gate');
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `SECTION-${suffix}`, courseKey: `COURSE-${suffix}`,
    title: 'Synthetic capacity-one section', capacity: 1, scopeType: 'organization', scopeId }, owner);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, owner);
  const requestInput = (studentId) => ({ studentId, periodId: period.id, offeringIds: [offering.id],
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId });
  const firstInput = requestInput(student1.id);
  const first = await registration.submit(firstInput, owner);
  const replay = await registration.submit(firstInput, owner);
  if (!replay.replayed || replay.id !== first.id) throw new Error('Registration retry was not idempotent');
  let changedReplayRejected = false;
  try { await registration.submit({ ...firstInput, studentId: student2.id }, owner); }
  catch (error) { changedReplayRejected = error instanceof ConflictException; }
  if (!changedReplayRejected) throw new Error('Changed registration replay was accepted');
  const decision = { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE', checks: [] },
    reason: 'Synthetic evaluator approved the registration', expectedVersion: 1 };
  let decisionDisabled = false;
  try { await disabled.decide(first.id, decision, owner); }
  catch (error) { decisionDisabled = error instanceof ForbiddenException; }
  if (!decisionDisabled) throw new Error('Registration decision bypassed its disabled gate');
  await registration.decide(first.id, decision, owner);
  const second = await registration.submit(requestInput(student2.id), owner);
  let capacityRejected = false;
  try { await registration.decide(second.id, decision, owner); }
  catch (error) { capacityRejected = error instanceof ConflictException; }
  if (!capacityRejected) throw new Error('Offering capacity was exceeded');
  await registration.decide(second.id, { ...decision, outcome: 'WAITLISTED',
    reason: 'Synthetic capacity waitlist' }, owner);
  let promotionDisabled = false;
  try { await disabled.promote(second.id, { evaluationEngine: 'synthetic-promoter',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC_QUEUE_HEAD' },
    reason: 'Synthetic promotion', expectedVersion: 2 }, promoter); }
  catch (error) { promotionDisabled = error instanceof ForbiddenException; }
  if (!promotionDisabled) throw new Error('Waitlist promotion bypassed disabled gate');
  let fullPromotionRejected = false;
  try { await registration.promote(second.id, { evaluationEngine: 'synthetic-promoter',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC_QUEUE_HEAD' },
    reason: 'Synthetic promotion', expectedVersion: 2 }, promoter); }
  catch (error) { fullPromotionRejected = error instanceof ConflictException; }
  if (!fullPromotionRejected) throw new Error('Waitlist promotion exceeded offering capacity');
  let withdrawalDisabled = false;
  try { await disabled.withdraw(first.id, { reason: 'Synthetic seat release', expectedVersion: 2 }, owner); }
  catch (error) { withdrawalDisabled = error instanceof ForbiddenException; }
  if (!withdrawalDisabled) throw new Error('Registration withdrawal bypassed disabled gate');
  await registration.withdraw(first.id, { reason: 'Synthetic seat release', expectedVersion: 2 }, owner);
  let promotionMakerChecker = false;
  try { await registration.promote(second.id, { evaluationEngine: 'synthetic-promoter',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC_QUEUE_HEAD' },
    reason: 'Synthetic promotion', expectedVersion: 2 }, owner); }
  catch (error) { promotionMakerChecker = error instanceof ForbiddenException; }
  if (!promotionMakerChecker) throw new Error('Waitlist decision maker promoted own request');
  await registration.promote(second.id, { evaluationEngine: 'synthetic-promoter',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC_QUEUE_HEAD' },
    reason: 'Synthetic promotion', expectedVersion: 2 }, promoter);
  const concurrentOffering = await registration.createOffering({ periodId: period.id,
    offeringKey: `RACE-${suffix}`, courseKey: `RACE-COURSE-${suffix}`,
    title: 'Synthetic concurrent capacity-one section', capacity: 1,
    scopeType: 'organization', scopeId }, owner);
  await registration.publishOffering(concurrentOffering.id, { expectedRecordVersion: 1 }, owner);
  const concurrentInput = (studentId) => ({ studentId, periodId: period.id,
    offeringIds: [concurrentOffering.id], idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId });
  const request3 = await registration.submit(concurrentInput(student3.id), owner);
  const request4 = await registration.submit(concurrentInput(student4.id), owner);
  const race = await Promise.allSettled([
    registration.decide(request3.id, decision, owner),
    registration.decide(request4.id, decision, owner),
  ]);
  if (race.filter((result) => result.status === 'fulfilled').length !== 1
    || race.filter((result) => result.status === 'rejected'
      && result.reason instanceof ConflictException).length !== 1) {
    throw new Error('Concurrent one-seat registration did not serialize to one confirmation');
  }
  let decisionMutationRejected = false;
  try { await dataSource.query("UPDATE registration.decisions SET reason='tampered' WHERE request_id=$1", [first.id]); }
  catch { decisionMutationRejected = true; }
  if (!decisionMutationRejected) throw new Error('Registration decision evidence was mutable');
  const proofRows = await dataSource.query(`SELECT r.status,r.version,d.evaluation_engine,d.regulation_id,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='registration-request'
      AND resource_id=r.id::text) audits,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='registration-request'
      AND aggregate_id=r.id::text AND event_type='RegistrationConfirmed' LIMIT 1) payload
    FROM registration.requests r JOIN registration.decisions d ON d.request_id=r.id WHERE r.id=$1`, [first.id]);
  const proof = proofRows[0];
  if (proof?.status !== 'CANCELLED' || proof?.version !== 3 || proof?.audits !== 3
    || proof?.evaluation_engine !== 'synthetic-evaluator' || proof?.regulation_id !== regulation.id
    || JSON.stringify(Object.keys(proof?.payload ?? {}).sort())
      !== JSON.stringify(['registrationRequestId', 'studentId'])) {
    throw new Error('Registration decision or minimum-data evidence is incomplete');
  }
  const waitlistRows = await dataSource.query(`SELECT r.status,r.version,w.status waitlist_status,
    p.evaluation_engine,(SELECT count(*)::int FROM platform.audit_events
      WHERE resource_type='registration-request' AND resource_id=r.id::text) audits
    FROM registration.requests r JOIN registration.waitlist_entries w ON w.request_id=r.id
    JOIN registration.waitlist_promotions p ON p.request_id=r.id WHERE r.id=$1`, [second.id]);
  const waitlist = waitlistRows[0];
  if (waitlist?.status !== 'CONFIRMED' || waitlist?.version !== 3
    || waitlist?.waitlist_status !== 'PROMOTED' || waitlist?.evaluation_engine !== 'synthetic-promoter'
    || waitlist?.audits !== 3) throw new Error('Waitlist promotion evidence is incomplete');
  process.stdout.write('Registration gates, idempotency, evaluator evidence, serialized capacity, FIFO waitlist promotion, withdrawal seat release, maker-checker, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
