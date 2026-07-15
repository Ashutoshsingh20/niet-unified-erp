import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationEligibilityService } from '../apps/api/dist/modules/registration/registration-eligibility.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { TimetableService } from '../apps/api/dist/modules/timetable/timetable.service.js';
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
    throw new Error('Registration eligibility verification requires _test');
  }
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID(); const now = Date.now();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED'].includes(key) };
  const setupConfig = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED',
    'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED'].includes(key) };
  const governed = new RegistrationService(dataSource, policy, evidence, enabled);
  const setupRegistration = new RegistrationService(dataSource, policy, evidence, setupConfig);
  const eligibility = new RegistrationEligibilityService(dataSource, policy, evidence);
  const timetable = new TimetableService(dataSource, policy, evidence, enabled);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabled);
  const students = new StudentsService(dataSource, policy, evidence);
  const studentActor = { subjectId: `eligibility-student-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const adviser = { ...studentActor, subjectId: `eligibility-adviser-${suffix}` };
  const outsider = { ...adviser, subjectId: `eligibility-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const secondActor = { ...studentActor, subjectId: `eligibility-student-two-${suffix}` };
  const createStudent = (actor, key) => students.create({ idempotencyKey: randomUUID(),
    subjectId: actor.subjectId, displayName: `Synthetic eligibility student ${key}`,
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-registration',
    sourceKey: `eligibility-${key}-${suffix}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: key.repeat(64).slice(0, 64) }, studentActor);
  const student = await createStudent(studentActor, '1');
  const secondStudent = await createStudent(secondActor, '2');
  const period = await governed.createPeriod({ periodKey: `eligibility-${suffix}`, version: 1,
    title: 'Synthetic eligibility period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, adviser);
  await governed.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-ELIGIBILITY-POLICY' }, adviser);
  const offerings = [];
  for (const key of ['A', 'B', 'C']) {
    const offering = await governed.createOffering({ periodId: period.id,
      offeringKey: `ELIGIBILITY-${key}-${suffix}`, courseKey: `COURSE-${key}-${suffix}`,
      title: `Synthetic eligibility offering ${key}`, capacity: 10,
      scopeType: 'organization', scopeId }, adviser);
    await governed.publishOffering(offering.id, { expectedRecordVersion: 1 }, adviser);
    offerings.push(offering);
  }
  const times = [[600, 660], [630, 690], [700, 760]];
  for (let index = 0; index < offerings.length; index += 1) {
    const meeting = await timetable.create({ offeringId: offerings[index].id,
      meetingKey: `ELIGIBILITY-M${index}-${suffix}`, weekday: 1,
      startMinute: times[index][0], endMinute: times[index][1],
      roomKey: `ELIGIBILITY-ROOM-${index}-${suffix}`,
      instructorSubjectId: `eligibility-instructor-${index}-${suffix}`,
      scopeType: 'organization', scopeId }, adviser);
    await timetable.publish(meeting.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-ELIGIBILITY-POLICY' }, adviser);
  }
  const existing = await setupRegistration.submit({ studentId: student.id, periodId: period.id,
    offeringIds: [offerings[0].id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, studentActor);
  const regulation = await curriculum.create({ regulationKey: `eligibility-${suffix}`, version: 1,
    title: 'Synthetic eligibility regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_ACCEPT_ALL' },
    impactSummary: 'Synthetic request-time registration eligibility evidence.' }, adviser);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-ELIGIBILITY-POLICY' }, adviser);
  await setupRegistration.decide(existing.id, { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-setup', evaluationVersion: 'v1',
    evaluationTrace: { result: 'ELIGIBLE' }, reason: 'Synthetic confirmed prerequisite',
    expectedVersion: 1 }, adviser);

  const approvalInput = (offeringIds, idempotencyKey = randomUUID()) => ({ studentId: student.id,
    periodId: period.id, offeringIds, idempotencyKey,
    policyReference: 'SYNTHETIC-ELIGIBILITY-POLICY',
    evidenceReference: 'SYNTHETIC-ADVISER-EVIDENCE', reason: 'Synthetic adviser approval evidence',
    scopeType: 'organization', scopeId });
  let selfApprovalRejected = false;
  try { await eligibility.approve(approvalInput([offerings[2].id]), studentActor); }
  catch (error) { selfApprovalRejected = error instanceof ForbiddenException; }
  if (!selfApprovalRejected) throw new Error('Student self-approval was accepted');
  let scopeRejected = false;
  try { await eligibility.approve(approvalInput([offerings[2].id]), outsider); }
  catch (error) { scopeRejected = error instanceof ForbiddenException; }
  if (!scopeRejected) throw new Error('Adviser approval ignored scope');
  const concurrentInput = approvalInput([offerings[2].id]);
  const approvalResults = await Promise.all([
    eligibility.approve(concurrentInput, adviser), eligibility.approve(concurrentInput, adviser),
  ]);
  const approval = approvalResults.find((result) => !result.replayed);
  if (approval === undefined || approvalResults.filter((result) => result.replayed).length !== 1
    || approvalResults.some((result) => result.id !== approval.id)) {
    throw new Error('Concurrent adviser approval replay failed');
  }
  const wrongApproval = await eligibility.approve(approvalInput([offerings[0].id]), adviser);
  const snapshot = { requestedCreditUnits: '3.00', maximumCreditUnits: '24.00',
    adviserRequired: true, adviserApprovalId: approval.id,
    evaluationEngine: 'synthetic-credit-policy', evaluationVersion: 'v1',
    policyReference: 'SYNTHETIC-ELIGIBILITY-POLICY', evaluationTrace: { result: 'ELIGIBLE' } };
  const request = (studentId, offeringIds, eligibilitySnapshot, idempotencyKey = randomUUID()) => ({
    studentId, periodId: period.id, offeringIds, idempotencyKey,
    scopeType: 'organization', scopeId, ...(eligibilitySnapshot === undefined ? {} : { eligibilitySnapshot }) });
  await expectConflict(() => governed.submit(request(student.id, [offerings[2].id], undefined), studentActor),
    'Missing eligibility snapshot was accepted');
  await expectConflict(() => governed.submit(request(student.id, [offerings[2].id],
    { ...snapshot, requestedCreditUnits: '25.00' }), studentActor), 'Excess credit request was accepted');
  await expectConflict(() => governed.submit(request(student.id, [offerings[2].id],
    { ...snapshot, adviserApprovalId: undefined }), studentActor), 'Missing adviser approval was accepted');
  await expectConflict(() => governed.submit(request(student.id, [offerings[2].id],
    { ...snapshot, adviserApprovalId: wrongApproval.id }), studentActor), 'Mismatched adviser approval was accepted');
  await expectConflict(() => governed.submit(request(student.id, [offerings[1].id],
    { ...snapshot, adviserApprovalId: undefined, adviserRequired: false }), studentActor),
  'Confirmed timetable conflict was accepted');
  await expectConflict(() => governed.submit(request(secondStudent.id, [offerings[0].id, offerings[1].id],
    { ...snapshot, adviserApprovalId: undefined, adviserRequired: false,
      requestedCreditUnits: '6.00' }), secondActor), 'Internal timetable conflict was accepted');
  const idempotencyKey = randomUUID();
  const validInput = request(student.id, [offerings[2].id], snapshot, idempotencyKey);
  const submitted = await governed.submit(validInput, studentActor);
  const replayed = await governed.submit(validInput, studentActor);
  if (!replayed.replayed || replayed.id !== submitted.id) throw new Error('Exact eligibility replay failed');
  await expectConflict(() => governed.submit({ ...validInput,
    eligibilitySnapshot: { ...snapshot, maximumCreditUnits: '23.00' } }, studentActor),
  'Changed eligibility replay was accepted');
  let mutationRejected = false;
  try { await dataSource.query(`UPDATE registration.request_eligibility_snapshots
    SET maximum_credit_units=23 WHERE request_id=$1`, [submitted.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Eligibility snapshot was mutable');
  const proof = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM registration.request_eligibility_snapshots WHERE request_id=$1) snapshots,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='registration-adviser-approval'
      AND resource_id IN ($2::text,$3::text)) approval_audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='registration-adviser-approval'
      AND aggregate_id IN ($2::text,$3::text)) approval_events`,
  [submitted.id, approval.id, wrongApproval.id]);
  if (proof[0]?.snapshots !== 1 || proof[0]?.approval_audits !== 2 || proof[0]?.approval_events !== 2) {
    throw new Error('Eligibility evidence, audit, or outbox proof is incomplete');
  }
  process.stdout.write('Immutable request-time credit policy snapshots, non-self adviser approval, exact offering manifests, concurrent replay, published timetable conflict derivation, fail-closed enforcement, tamper rejection, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

async function expectConflict(action, message) {
  let rejected = false;
  try { await action(); } catch (error) { rejected = error instanceof ConflictException; }
  if (!rejected) throw new Error(message);
}
