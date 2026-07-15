import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { RegistrationWindowsService } from '../apps/api/dist/modules/registration/registration-windows.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Registration window verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID(); const now = Date.now();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const config = { get: (key) => ['ACADEMIC_POLICY_PUBLICATION_ENABLED', 'REGISTRATION_DECISION_ENABLED',
    'REGISTRATION_WITHDRAWAL_ENABLED', 'REGISTRATION_WINDOW_PUBLICATION_ENABLED',
    'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED'].includes(key) };
  const registration = new RegistrationService(dataSource, policy, evidence, config);
  const windows = new RegistrationWindowsService(dataSource, policy, evidence, config);
  const disabledWindows = new RegistrationWindowsService(dataSource, policy, evidence, { get: () => false });
  const curriculum = new CurriculumService(dataSource, policy, evidence, config);
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `window-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `window-checker-${suffix}` };
  const outsider = { ...checker, subjectId: `window-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const student = await students.create({ idempotencyKey: randomUUID(),
    subjectId: maker.subjectId, displayName: 'Synthetic Window Student', scopeType: 'organization', scopeId,
    sourceSystem: 'synthetic-admissions', sourceKey: `window-student-${suffix}`,
    sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
    sourceRowSha256: '1'.repeat(64) }, maker);
  const period = await registration.createPeriod({ periodKey: `window-period-${suffix}`, version: 1,
    title: 'Synthetic window academic period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, maker);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-WINDOW-POLICY' }, maker);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `WINDOW-${suffix}`, courseKey: `WINDOW-COURSE-${suffix}`,
    title: 'Synthetic window-controlled offering', capacity: 5,
    scopeType: 'organization', scopeId }, maker);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, maker);
  const requestInput = { studentId: student.id, periodId: period.id, offeringIds: [offering.id],
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId };
  let closedSubmissionRejected = false;
  try { await registration.submit(requestInput, maker); }
  catch (error) { closedSubmissionRejected = error instanceof ConflictException; }
  if (!closedSubmissionRejected) throw new Error('Registration submission bypassed missing window');
  const submissionInput = { windowKey: `submission.${suffix}`, version: 1, periodId: period.id,
    windowType: 'SUBMISSION', title: 'Synthetic registration submission window',
    opensAt: new Date(now - 3_600_000).toISOString(), closesAt: new Date(now + 3_600_000).toISOString(),
    scopeType: 'organization', scopeId, idempotencyKey: randomUUID() };
  const creations = await Promise.all([windows.create(submissionInput, maker), windows.create(submissionInput, maker)]);
  const submission = creations.find((result) => !result.replayed);
  if (submission === undefined || creations.filter((result) => result.replayed).length !== 1
    || creations.some((result) => result.id !== submission.id)) throw new Error('Window create replay failed');
  const publication = { expectedRecordVersion: 1, policyDecisionReference: 'SYNTHETIC-WINDOW-POLICY' };
  let disabledPublication = false;
  try { await disabledWindows.publish(submission.id, publication, checker); }
  catch (error) { disabledPublication = error instanceof ForbiddenException; }
  if (!disabledPublication) throw new Error('Window publication bypassed disabled gate');
  let makerDenied = false;
  try { await windows.publish(submission.id, publication, maker); }
  catch (error) { makerDenied = error instanceof ForbiddenException; }
  if (!makerDenied) throw new Error('Window maker published it');
  let scopeDenied = false;
  try { await windows.publish(submission.id, publication, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Window publication ignored scope');
  await windows.publish(submission.id, publication, checker);
  if (!(await windows.publish(submission.id, publication, checker)).replayed) {
    throw new Error('Window publication replay failed');
  }
  const active = await windows.active(period.id, 'SUBMISSION', checker);
  if (active.item?.id !== submission.id || active.item.status !== 'PUBLISHED') {
    throw new Error('Active registration window lookup failed');
  }
  const overlap = await windows.create({ ...submissionInput, windowKey: `overlap.${suffix}`, version: 2,
    idempotencyKey: randomUUID(), opensAt: new Date(now - 1_800_000).toISOString(),
    closesAt: new Date(now + 7_200_000).toISOString() }, maker);
  let overlapRejected = false;
  try { await windows.publish(overlap.id, publication, checker); }
  catch (error) { overlapRejected = error instanceof ConflictException; }
  if (!overlapRejected) throw new Error('Overlapping published registration windows were accepted');

  const request = await registration.submit(requestInput, maker);
  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL session_replication_role='replica'");
    await manager.query(`UPDATE registration.windows SET opens_at=$2,closes_at=$3 WHERE id=$1`,
      [submission.id, new Date(now - 7_200_000), new Date(now - 3_600_000)]);
  });
  const replay = await registration.submit(requestInput, maker);
  if (!replay.replayed || replay.id !== request.id) throw new Error('Exact retry failed after window closure');
  await dataSource.transaction(async (manager) => {
    await manager.query("SET LOCAL session_replication_role='replica'");
    await manager.query(`UPDATE registration.windows SET opens_at=$2,closes_at=$3 WHERE id=$1`,
      [submission.id, submissionInput.opensAt, submissionInput.closesAt]);
  });
  const regulation = await curriculum.create({ regulationKey: `window-regulation-${suffix}`, version: 1,
    title: 'Synthetic window registration regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_ACCEPT_ALL' },
    impactSummary: 'Synthetic policy evidence for registration-window verification.' }, maker);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-WINDOW-POLICY' }, maker);
  await registration.decide(request.id, { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-window-evaluator', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic window decision',
    expectedVersion: 1 }, maker);
  let closedAddDropRejected = false;
  try { await registration.withdraw(request.id, { reason: 'Synthetic add/drop withdrawal', expectedVersion: 2 }, maker); }
  catch (error) { closedAddDropRejected = error instanceof ConflictException; }
  if (!closedAddDropRejected) throw new Error('Confirmed withdrawal bypassed missing add/drop window');
  const addDrop = await windows.create({ windowKey: `add-drop.${suffix}`, version: 1, periodId: period.id,
    windowType: 'ADD_DROP', title: 'Synthetic add/drop window',
    opensAt: new Date(now - 3_600_000).toISOString(), closesAt: new Date(now + 3_600_000).toISOString(),
    scopeType: 'organization', scopeId, idempotencyKey: randomUUID() }, maker);
  await windows.publish(addDrop.id, publication, checker);
  await registration.withdraw(request.id, { reason: 'Synthetic add/drop withdrawal', expectedVersion: 2 }, maker);
  let mutationRejected = false;
  try { await dataSource.query("UPDATE registration.windows SET title='tampered' WHERE id=$1", [submission.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Published registration window was mutable');
  const proofRows = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='registration-window'
      AND resource_id IN ($1::text,$2::text)) audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='registration-window'
      AND aggregate_id IN ($1::text,$2::text)) events,
    (SELECT status FROM registration.requests WHERE id=$3) request_status`,
  [submission.id, addDrop.id, request.id]);
  if (proofRows[0]?.audits !== 4 || proofRows[0]?.events !== 2
    || proofRows[0]?.request_status !== 'CANCELLED') throw new Error('Window lifecycle evidence is incomplete');
  process.stdout.write('Versioned submission/add-drop windows, concurrent replay, maker-checker publication, overlap exclusion, active lookup, fail-closed submit/withdraw enforcement, post-close exact retry, immutable evidence, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
