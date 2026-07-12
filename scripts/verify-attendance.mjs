import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AttendanceService } from '../apps/api/dist/modules/attendance/attendance.service.js';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Attendance verification requires _test');
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: () => true };
  const disabledConfig = { get: () => false };
  const attendance = new AttendanceService(dataSource, policy, evidence, enabledConfig);
  const disabledAttendance = new AttendanceService(dataSource, policy, evidence, disabledConfig);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabledConfig);
  const registration = new RegistrationService(dataSource, policy, evidence, enabledConfig);
  const students = new StudentsService(dataSource, policy, evidence);
  const owner = { subjectId: `attendance-owner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const approver = { ...owner, subjectId: `attendance-approver-${suffix}` };
  const outsider = { ...owner, subjectId: `attendance-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const createStudent = (number) => students.create({ idempotencyKey: randomUUID(),
    subjectId: `attendance-student-${suffix}-${number}`, displayName: `Synthetic Student ${number}`,
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-admissions',
    sourceKey: `attendance-application-${suffix}-${number}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: String(number).repeat(64) }, owner);
  const student1 = await createStudent(1);
  const student2 = await createStudent(2);
  const regulation = await curriculum.create({ regulationKey: `synthetic.attendance-${suffix}`, version: 1,
    title: 'Synthetic attendance prerequisite regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_ACCEPT_ALL' },
    impactSummary: 'Synthetic rule used only to create an attendance verification roster.' }, owner);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `attendance-period-${suffix}`, version: 1,
    title: 'Synthetic attendance period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, owner);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `ATT-${suffix}`, courseKey: `COURSE-${suffix}`,
    title: 'Synthetic attendance section', capacity: 2, scopeType: 'organization', scopeId }, owner);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, owner);
  for (const student of [student1, student2]) {
    const request = await registration.submit({ studentId: student.id, periodId: period.id,
      offeringIds: [offering.id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, owner);
    await registration.decide(request.id, { outcome: 'CONFIRMED', regulationId: regulation.id,
      evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
      evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic roster confirmation',
      expectedVersion: 1 }, owner);
  }
  const session = await attendance.createSession({ offeringId: offering.id,
    sessionKey: `lecture-${suffix}`, startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 3_600_000).toISOString(), scopeType: 'organization', scopeId }, owner);
  let scopeDenied = false;
  try { await attendance.openSession(session.id, { expectedVersion: 1 }, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Attendance session ignored tenant scope');
  await attendance.openSession(session.id, { expectedVersion: 1 }, owner);
  const observation = (studentId, presenceState) => ({ studentId, presenceState,
    sourceKind: 'synthetic-verifier', sourceReference: `VERIFY-${suffix}`,
    observedAt: new Date().toISOString(), evidence: { synthetic: true } });
  await attendance.recordObservation(session.id, observation(student1.id, 'OBSERVED_PRESENT'), owner);
  let finalizationDisabled = false;
  try { await disabledAttendance.finalize(session.id, { expectedVersion: 2, reason: 'Synthetic close' }, owner); }
  catch (error) { finalizationDisabled = error instanceof ForbiddenException; }
  if (!finalizationDisabled) throw new Error('Attendance finalization bypassed its disabled gate');
  let incompleteRejected = false;
  try { await attendance.finalize(session.id, { expectedVersion: 2, reason: 'Synthetic close' }, owner); }
  catch (error) { incompleteRejected = error instanceof ConflictException; }
  if (!incompleteRejected) throw new Error('Incomplete attendance roster was finalized');
  await attendance.recordObservation(session.id, observation(student2.id, 'OBSERVED_ABSENT'), owner);
  let duplicateRejected = false;
  try { await attendance.recordObservation(session.id, observation(student2.id, 'NOT_OBSERVED'), owner); }
  catch (error) { duplicateRejected = error instanceof ConflictException; }
  if (!duplicateRejected) throw new Error('Duplicate attendance observation was accepted');
  await attendance.finalize(session.id, { expectedVersion: 2, reason: 'Synthetic complete roster close' }, owner);
  let observationMutationRejected = false;
  try { await dataSource.query("UPDATE teaching.attendance_observations SET presence_state='NOT_OBSERVED' WHERE session_id=$1", [session.id]); }
  catch { observationMutationRejected = true; }
  if (!observationMutationRejected) throw new Error('Attendance observation evidence was mutable');
  const correction = await attendance.requestCorrection(session.id, { studentId: student2.id,
    proposedState: 'OBSERVED_PRESENT', reason: 'Synthetic evidence review',
    evidenceReference: `SYNTHETIC-${suffix}` }, owner);
  let correctionDisabled = false;
  try { await disabledAttendance.approveCorrection(correction.id,
    { expectedRequestVersion: 1, expectedSessionVersion: 3 }, approver); }
  catch (error) { correctionDisabled = error instanceof ForbiddenException; }
  if (!correctionDisabled) throw new Error('Attendance correction bypassed its disabled gate');
  let makerCheckerEnforced = false;
  try { await attendance.approveCorrection(correction.id,
    { expectedRequestVersion: 1, expectedSessionVersion: 3 }, owner); }
  catch (error) { makerCheckerEnforced = error instanceof ForbiddenException; }
  if (!makerCheckerEnforced) throw new Error('Attendance requester approved their own correction');
  await attendance.approveCorrection(correction.id,
    { expectedRequestVersion: 1, expectedSessionVersion: 3 }, approver);
  let correctionMutationRejected = false;
  try { await dataSource.query("UPDATE teaching.attendance_corrections SET reason='tampered' WHERE correction_request_id=$1", [correction.id]); }
  catch { correctionMutationRejected = true; }
  if (!correctionMutationRejected) throw new Error('Attendance correction evidence was mutable');
  const proofRows = await dataSource.query(`SELECT s.status,s.version,s.observation_set_sha256,
    cr.status correction_status,cr.version correction_version,c.previous_state,c.corrected_state,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='teaching-session'
      AND resource_id=s.id::text) session_audits,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='teaching-session'
      AND aggregate_id=s.id::text AND event_type='AttendanceFinalized' LIMIT 1) finalized_payload,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='teaching-session'
      AND aggregate_id=s.id::text AND event_type='AttendanceCorrected' LIMIT 1) corrected_payload
    FROM teaching.sessions s
    JOIN teaching.attendance_correction_requests cr ON cr.session_id=s.id
    JOIN teaching.attendance_corrections c ON c.correction_request_id=cr.id WHERE s.id=$1`, [session.id]);
  const proof = proofRows[0];
  const minimumPayload = (payload) => JSON.stringify(Object.keys(payload ?? {})) === JSON.stringify(['teachingSessionId']);
  if (proof?.status !== 'FINALIZED' || proof?.version !== 4
    || !/^[a-f0-9]{64}$/.test(proof?.observation_set_sha256 ?? '')
    || proof?.correction_status !== 'APPROVED' || proof?.correction_version !== 2
    || proof?.previous_state !== 'OBSERVED_ABSENT' || proof?.corrected_state !== 'OBSERVED_PRESENT'
    || proof?.session_audits !== 3 || !minimumPayload(proof?.finalized_payload)
    || !minimumPayload(proof?.corrected_payload)) {
    throw new Error('Attendance finalization, correction, audit, or minimum-data evidence is incomplete');
  }
  process.stdout.write('Attendance scope, gates, complete roster, immutable evidence, maker-checker correction, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
