import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationOverridesService } from '../apps/api/dist/modules/registration/registration-overrides.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { TimetableService } from '../apps/api/dist/modules/timetable/timetable.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { WaitlistExpiryService } from '../apps/worker/dist/registration/waitlist-expiry.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Override verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID(); const now = Date.now();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = { get: (key) => key !== 'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED' };
  const setupConfig = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED',
    'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED', 'WAITLIST_EXPIRY_ENFORCEMENT_ENABLED'].includes(key) };
  const disabled = { get: () => false };
  const registration = new RegistrationService(dataSource, policy, evidence, enabled);
  const setupRegistration = new RegistrationService(dataSource, policy, evidence, setupConfig);
  const overrides = new RegistrationOverridesService(dataSource, policy, evidence, enabled);
  const disabledOverrides = new RegistrationOverridesService(dataSource, policy, evidence, disabled);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabled);
  const timetable = new TimetableService(dataSource, policy, evidence, enabled);
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `override-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `override-checker-${suffix}` };
  const studentOneActor = { ...maker, subjectId: `override-student-one-${suffix}` };
  const studentTwoActor = { ...maker, subjectId: `override-student-two-${suffix}` };
  const student = async (actor, key) => students.create({ idempotencyKey: randomUUID(),
    subjectId: actor.subjectId, displayName: `Synthetic override student ${key}`,
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-registration',
    sourceKey: `override-${key}-${suffix}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: key.repeat(64).slice(0, 64) }, maker);
  const studentOne = await student(studentOneActor, '1'); const studentTwo = await student(studentTwoActor, '2');
  const period = await registration.createPeriod({ periodKey: `override-${suffix}`, version: 1,
    title: 'Synthetic override period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, maker);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-OVERRIDE-POLICY' }, maker);
  const offerings = [];
  for (const key of ['A', 'B', 'C']) {
    const item = await registration.createOffering({ periodId: period.id,
      offeringKey: `OVERRIDE-${key}-${suffix}`, courseKey: `COURSE-${key}-${suffix}`,
      title: `Synthetic override offering ${key}`, capacity: 1,
      scopeType: 'organization', scopeId }, maker);
    await registration.publishOffering(item.id, { expectedRecordVersion: 1 }, maker); offerings.push(item);
  }
  for (let index = 0; index < 2; index += 1) {
    const meeting = await timetable.create({ offeringId: offerings[index].id,
      meetingKey: `OVERRIDE-M${index}-${suffix}`, weekday: 1, startMinute: 600 + index * 30,
      endMinute: 660 + index * 30, roomKey: `OVERRIDE-ROOM-${index}-${suffix}`,
      instructorSubjectId: `override-instructor-${index}-${suffix}`,
      scopeType: 'organization', scopeId }, maker);
    await timetable.publish(meeting.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-OVERRIDE-POLICY' }, maker);
  }
  const regulation = await curriculum.create({ regulationKey: `override-${suffix}`, version: 1,
    title: 'Synthetic override regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC' },
    impactSummary: 'Synthetic override and waitlist-expiry evidence.' }, maker);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-OVERRIDE-POLICY' }, maker);
  const overrideInput = (studentId, offeringIds, exceptionType) => ({ studentId, periodId: period.id,
    offeringIds, exceptionType, idempotencyKey: randomUUID(), policyReference: 'SYNTHETIC-OVERRIDE-POLICY',
    evidenceReference: 'SYNTHETIC-EXCEPTION-EVIDENCE', reason: 'Synthetic governed exception evidence',
    evaluationEngine: 'synthetic-override-evaluator', evaluationVersion: 'v1',
    evaluationTrace: { exceptionType }, scopeType: 'organization', scopeId });
  const timetableInput = overrideInput(studentTwo.id, [offerings[0].id, offerings[1].id], 'TIMETABLE_CONFLICT');
  const draft = await overrides.create(timetableInput, maker);
  const replay = await overrides.create(timetableInput, maker);
  if (!replay.replayed || replay.id !== draft.id) throw new Error('Override exact replay failed');
  await expectForbidden(() => disabledOverrides.decide(draft.id,
    { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker), 'Override bypassed disabled gate');
  await expectForbidden(() => overrides.decide(draft.id,
    { outcome: 'APPROVED', expectedRecordVersion: 1 }, maker), 'Override requester approved it');
  const snapshot = { requestedCreditUnits: '6.00', maximumCreditUnits: '24.00', adviserRequired: false,
    evaluationEngine: 'synthetic-registration-evaluator', evaluationVersion: 'v1',
    policyReference: 'SYNTHETIC-OVERRIDE-POLICY', evaluationTrace: { result: 'ELIGIBLE' } };
  const request = (studentId, offeringIds, eligibilitySnapshot, overrideAuthorizationIds = []) => ({
    studentId, periodId: period.id, offeringIds, idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId, eligibilitySnapshot, overrideAuthorizationIds });
  await expectConflict(() => registration.submit(request(studentTwo.id,
    [offerings[0].id, offerings[1].id], snapshot, [draft.id]), studentTwoActor),
  'Draft override was consumed');
  await overrides.decide(draft.id, { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker);
  await expectConflict(() => registration.submit(request(studentTwo.id,
    [offerings[0].id, offerings[1].id], snapshot), studentTwoActor), 'Timetable conflict bypassed override');
  const overrideRequestInput = request(studentTwo.id,
    [offerings[0].id, offerings[1].id], snapshot, [draft.id]);
  const overridden = await registration.submit(overrideRequestInput, studentTwoActor);
  const requestReplay = await registration.submit(overrideRequestInput, studentTwoActor);
  if (!requestReplay.replayed || requestReplay.id !== overridden.id) {
    throw new Error('Override-backed registration exact replay failed');
  }
  await expectConflict(() => registration.submit(request(studentTwo.id,
    [offerings[0].id, offerings[1].id], snapshot, [draft.id]), studentTwoActor),
  'Single-use override was consumed twice');
  const conflictProof = await dataSource.query(`SELECT s.timetable_conflict_count,u.exception_type
    FROM registration.request_eligibility_snapshots s JOIN registration.request_override_usages u
      ON u.request_id=s.request_id WHERE s.request_id=$1`, [overridden.id]);
  if (conflictProof[0]?.timetable_conflict_count !== 1
    || conflictProof[0]?.exception_type !== 'TIMETABLE_CONFLICT') throw new Error('Conflict override proof missing');

  const occupied = await setupRegistration.submit({ studentId: studentOne.id, periodId: period.id,
    offeringIds: [offerings[2].id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId },
  studentOneActor);
  const decision = { regulationId: regulation.id, evaluationEngine: 'synthetic-decision',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC' },
    reason: 'Synthetic registration decision', expectedVersion: 1 };
  await setupRegistration.decide(occupied.id, { ...decision, outcome: 'CONFIRMED' }, checker);
  const capacity = await overrides.create(overrideInput(studentTwo.id, [offerings[2].id], 'CAPACITY'), maker);
  await overrides.decide(capacity.id, { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker);
  const capacityRequest = await registration.submit(request(studentTwo.id, [offerings[2].id],
    { ...snapshot, requestedCreditUnits: '3.00' }, [capacity.id]), studentTwoActor);
  await registration.decide(capacityRequest.id, { ...decision, outcome: 'CONFIRMED' }, checker);

  const waitlistRequest = await registration.submit(request(studentOne.id, [offerings[1].id],
    { ...snapshot, requestedCreditUnits: '3.00' }), studentOneActor);
  await expectConflict(() => registration.decide(waitlistRequest.id,
    { ...decision, outcome: 'WAITLISTED' }, checker), 'Waitlist decision omitted governed expiry terms');
  const expiresAt = new Date(Date.now() + 4_000).toISOString();
  await registration.decide(waitlistRequest.id, { ...decision, outcome: 'WAITLISTED',
    waitlistTerms: { expiresAt, policyReference: 'SYNTHETIC-WAITLIST-POLICY',
      evaluationEngine: 'synthetic-expiry-evaluator', evaluationVersion: 'v1',
      evaluationTrace: { source: 'SYNTHETIC_POLICY' } } }, checker);
  await new Promise((resolve) => setTimeout(resolve, 4_100));
  await expectConflict(() => registration.promote(waitlistRequest.id, {
    evaluationEngine: 'synthetic-promoter', evaluationVersion: 'v1', evaluationTrace: {},
    reason: 'Synthetic late promotion', expectedVersion: 2 }, maker), 'Expired waitlist was promoted');
  const processor = new WaitlistExpiryService(pool, `verifier-${suffix}`);
  if (!await processor.processOne() || await processor.processOne()) throw new Error('Expiry processing was not idempotent');
  const expiryProof = await dataSource.query(`SELECT r.status,r.version,w.status entry_status,
    x.policy_reference,(SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type='registration-request' AND aggregate_id=r.id::text
        AND event_type='RegistrationWaitlistExpired') events
    FROM registration.requests r JOIN registration.waitlist_entries w ON w.request_id=r.id
    JOIN registration.waitlist_expirations x ON x.request_id=r.id WHERE r.id=$1`, [waitlistRequest.id]);
  if (expiryProof[0]?.status !== 'CANCELLED' || expiryProof[0]?.version !== 3
    || expiryProof[0]?.entry_status !== 'REMOVED'
    || expiryProof[0]?.policy_reference !== 'SYNTHETIC-WAITLIST-POLICY'
    || expiryProof[0]?.events !== 1) throw new Error('Waitlist expiration evidence is incomplete');
  let mutationRejected = false;
  try { await dataSource.query("UPDATE registration.override_authorizations SET reason='tampered' WHERE id=$1", [draft.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Approved override was mutable');
  process.stdout.write('Maker-checker exact-manifest registration overrides, single-use evidence, detected-exception matching, capacity/timetable authorization, policy-supplied waitlist terms, late-promotion rejection, idempotent timed expiry, seat release, audit, and outbox verified\n');
} finally { await dataSource.destroy(); await pool.end(); }

async function expectConflict(action, message) {
  try { await action(); } catch (error) { if (error instanceof ConflictException) return; throw error; }
  throw new Error(message);
}
async function expectForbidden(action, message) {
  try { await action(); } catch (error) { if (error instanceof ForbiddenException) return; throw error; }
  throw new Error(message);
}
