import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { FinanceService } from '../apps/api/dist/modules/finance/finance.service.js';
import { HoldsService } from '../apps/api/dist/modules/holds/holds.service.js';
import { ProgrammesService } from '../apps/api/dist/modules/programmes/programmes.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { StudentWithdrawalsService } from '../apps/api/dist/modules/student-withdrawals/student-withdrawals.service.js';
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
    throw new Error('Student withdrawal verification requires a _test database');
  }
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const config = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED',
    'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED'].includes(key) };
  const students = new StudentsService(dataSource, policy, evidence);
  const curriculum = new CurriculumService(dataSource, policy, evidence, config);
  const programmes = new ProgrammesService(dataSource, policy, evidence, config);
  const registration = new RegistrationService(dataSource, policy, evidence, config);
  const holds = new HoldsService(dataSource, policy, evidence, config);
  const finance = new FinanceService(dataSource, policy, evidence, config);
  const withdrawals = new StudentWithdrawalsService(dataSource, policy, evidence, config);
  const disabled = new StudentWithdrawalsService(dataSource, policy, evidence, { get: () => false });
  const studentPrincipal = { subjectId: `withdrawal-student-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const operator = { ...studentPrincipal, subjectId: `withdrawal-operator-${suffix}` };
  const checker = { ...studentPrincipal, subjectId: `withdrawal-checker-${suffix}` };
  const outsider = { ...operator, subjectId: `withdrawal-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const policyReference = 'SYNTHETIC-STUDENT-WITHDRAWAL-POLICY';

  async function createStudent(subjectId, label) {
    return students.create({ idempotencyKey: randomUUID(), subjectId,
      displayName: `Synthetic ${label} Student`, scopeType: 'organization', scopeId,
      sourceSystem: 'synthetic-withdrawal', sourceKey: `${label}-${suffix}`,
      sourceExtractedAt: new Date().toISOString(), mappingVersion: 'v1',
      sourceRowSha256: randomUUID().replaceAll('-', '').repeat(2) }, operator);
  }

  const student = await createStudent(studentPrincipal.subjectId, 'withdrawal');
  const regulation = await curriculum.create({ regulationKey: `withdrawal-${suffix}`, version: 1,
    title: 'Synthetic withdrawal regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'v1', ruleDocument: { kind: 'SYNTHETIC_WITHDRAWAL' },
    impactSummary: 'Synthetic withdrawal verification regulation.' }, operator);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: policyReference }, operator);
  const programme = await programmes.create({ programmeKey: `WITHDRAWAL-${suffix}`, version: 1,
    title: 'Synthetic withdrawal programme', regulationId: regulation.id,
    structureManifestSha256: 'a'.repeat(64), scopeType: 'organization', scopeId }, operator);
  await programmes.publish(programme.id, { expectedRecordVersion: 1,
    policyDecisionReference: policyReference }, operator);
  const enrolment = await programmes.assign({ studentId: student.id, programmeVersionId: programme.id,
    startsOn: new Date().toISOString().slice(0, 10), assignmentEngine: 'synthetic-assignment',
    assignmentVersion: 'v1', assignmentTrace: { result: 'SYNTHETIC_ASSIGNED' },
    scopeType: 'organization', scopeId }, operator);
  await programmes.activate(enrolment.id, { expectedVersion: 1 }, checker);

  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `withdrawal-${suffix}`, version: 1,
    title: 'Synthetic withdrawal period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, operator);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: policyReference }, operator);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `WITHDRAWAL-SECTION-${suffix}`, courseKey: `WITHDRAWAL-COURSE-${suffix}`,
    title: 'Synthetic withdrawal course', capacity: 5, scopeType: 'organization', scopeId }, operator);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, operator);
  const registrationRequest = await registration.submit({ studentId: student.id, periodId: period.id,
    offeringIds: [offering.id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, studentPrincipal);
  await registration.decide(registrationRequest.id, { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-registration', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC_CONFIRMED' }, reason: 'Synthetic confirmation',
    expectedVersion: 1 }, operator);
  const account = await finance.createAccount({ studentId: student.id, currency: 'INR',
    scopeType: 'organization', scopeId }, operator);
  await finance.post({ accountId: account.id, amountMinor: '1000', currency: 'INR',
    idempotencyKey: randomUUID(), evidenceReference: 'SYNTHETIC-WITHDRAWAL-DEMAND' }, 'DEMAND', operator);

  const hold = await holds.propose({ studentId: student.id, holdKey: `WITHDRAWAL-${suffix}`,
    effect: 'REGISTRATION_SUBMISSION', policyReference, reason: 'Synthetic withdrawal blocker',
    evidenceReference: 'SYNTHETIC-WITHDRAWAL-HOLD', scopeType: 'organization', scopeId }, operator);
  await holds.activate(hold.id, { expectedVersion: 1 }, checker);

  const requestInput = { studentId: student.id, idempotencyKey: randomUUID(),
    expectedStudentVersion: 1, reason: 'Student requests synthetic governed withdrawal' };
  let disabledGate = false;
  try { await disabled.request(requestInput, studentPrincipal); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Student withdrawal bypassed its disabled gate');
  let selfDenied = false;
  try { await withdrawals.request(requestInput, operator); }
  catch (error) { selfDenied = error instanceof ForbiddenException; }
  if (!selfDenied) throw new Error('Non-student requested withdrawal');
  const request = await withdrawals.request(requestInput, studentPrincipal);
  const requestReplay = await withdrawals.request(requestInput, studentPrincipal);
  if (!requestReplay.replayed || requestReplay.id !== request.id) {
    throw new Error('Student withdrawal request was not idempotent');
  }
  const worklist = await withdrawals.list({ scopeType: 'organization', scopeId, limit: 50 }, operator);
  const workItem = worklist.items.find((item) => item.requestId === request.id);
  if (workItem?.activeHoldCount !== 1 || workItem.openRegistrationCount !== 1
    || workItem.openProgrammeEnrolmentCount !== 1 || workItem.nonZeroAccountCount !== 1) {
    throw new Error('Student withdrawal worklist did not expose authoritative dependencies');
  }
  let scopeDenied = false;
  try { await withdrawals.list({ scopeType: 'organization', scopeId, limit: 50 }, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Student withdrawal worklist ignored tenant scope');
  const decision = { expectedRequestVersion: 1, decision: 'APPROVED',
    evaluationEngine: 'synthetic-withdrawal-evaluator', evaluationVersion: 'v1', policyReference,
    evaluationTrace: { result: 'SYNTHETIC_APPROVED' }, reason: 'Synthetic governed withdrawal approved' };
  let requesterDecisionDenied = false;
  try { await withdrawals.decide(request.id, decision, studentPrincipal); }
  catch (error) { requesterDecisionDenied = error instanceof ForbiddenException; }
  if (!requesterDecisionDenied) throw new Error('Withdrawal requester approved the same request');
  let holdBlocked = false;
  try { await withdrawals.decide(request.id, decision, operator); }
  catch (error) { holdBlocked = error instanceof ConflictException; }
  if (!holdBlocked) throw new Error('Active hold did not block student withdrawal');
  await holds.release(hold.id, { expectedVersion: 2, reason: 'Synthetic blocker cleared',
    evidenceReference: 'SYNTHETIC-WITHDRAWAL-HOLD-RELEASE' }, checker);
  const approved = await withdrawals.decide(request.id, decision, operator);
  const approvedReplay = await withdrawals.decide(request.id, decision, operator);
  if (approved.status !== 'WITHDRAWN' || approved.replayed || !approvedReplay.replayed) {
    throw new Error('Student withdrawal decision was not exactly idempotent');
  }

  const rejectedStudentPrincipal = { ...studentPrincipal, subjectId: `rejected-student-${suffix}` };
  const rejectedStudent = await createStudent(rejectedStudentPrincipal.subjectId, 'rejected');
  const rejectedRequest = await withdrawals.request({ studentId: rejectedStudent.id,
    idempotencyKey: randomUUID(), expectedStudentVersion: 1,
    reason: 'Synthetic rejected withdrawal request' }, rejectedStudentPrincipal);
  const rejected = await withdrawals.decide(rejectedRequest.id, { ...decision, decision: 'REJECTED',
    evaluationTrace: { result: 'SYNTHETIC_REJECTED' }, reason: 'Synthetic withdrawal rejected' }, operator);
  if (rejected.status !== 'REJECTED') throw new Error('Rejected withdrawal changed student status');

  let directStatusRejected = false;
  try { await dataSource.query("UPDATE student.records SET status='WITHDRAWN',version=version+1 WHERE id=$1",
    [rejectedStudent.id]); } catch { directStatusRejected = true; }
  if (!directStatusRejected) throw new Error('Student status changed without append-only history');
  let decisionMutationRejected = false;
  try { await dataSource.query("UPDATE student.withdrawal_decisions SET reason='tampered'"); }
  catch { decisionMutationRejected = true; }
  if (!decisionMutationRejected) throw new Error('Student withdrawal decision evidence was mutable');

  const proofRows = await dataSource.query(`SELECT s.status,s.version,r.status request_status,r.version request_version,
    pe.status enrolment_status,rr.status registration_status,
    (SELECT count(*)::int FROM student.status_history WHERE student_id=s.id) history,
    (SELECT count(*)::int FROM student.programme_enrolment_withdrawals
      WHERE withdrawal_request_id=r.id) enrolment_withdrawals,
    (SELECT count(*)::int FROM registration.withdrawals WHERE request_id=rr.id) registration_withdrawals,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='student-withdrawal-request'
      AND resource_id=r.id::text) audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='student-withdrawal-request'
      AND aggregate_id=r.id::text) events
    FROM student.records s JOIN student.withdrawal_requests r ON r.student_id=s.id
    JOIN student.programme_enrolments pe ON pe.student_id=s.id
    JOIN registration.requests rr ON rr.student_id=s.id WHERE s.id=$1`, [student.id]);
  const proof = proofRows[0];
  if (proof?.status !== 'WITHDRAWN' || proof?.version !== 2 || proof?.request_status !== 'WITHDRAWN'
    || proof?.request_version !== 2 || proof?.enrolment_status !== 'WITHDRAWN'
    || proof?.registration_status !== 'CANCELLED' || proof?.history !== 2
    || proof?.enrolment_withdrawals !== 1 || proof?.registration_withdrawals !== 1
    || proof?.audits !== 2 || proof?.events !== 2) {
    throw new Error('Student withdrawal cross-domain state or evidence is incomplete');
  }
  process.stdout.write('Student-owned withdrawal, scoped dependency worklist, hold/finance fail-closed boundary, maker-checker decision, atomic programme/registration closure, status history, exact replay, immutable evidence, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}
