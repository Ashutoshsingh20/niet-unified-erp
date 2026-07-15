import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HoldsService } from '../apps/api/dist/modules/holds/holds.service.js';
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
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Hold verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: (key) => key !== 'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED' };
  const disabledConfig = { get: () => false };
  const noHoldConfig = { get: (key) => !['STUDENT_HOLD_ENFORCEMENT_ENABLED',
    'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED'].includes(key) };
  const students = new StudentsService(dataSource, policy, evidence);
  const holds = new HoldsService(dataSource, policy, evidence, enabledConfig);
  const disabledHolds = new HoldsService(dataSource, policy, evidence, disabledConfig);
  const registration = new RegistrationService(dataSource, policy, evidence, enabledConfig);
  const registrationWithoutEnforcement = new RegistrationService(dataSource, policy, evidence, noHoldConfig);
  const proposer = { subjectId: `hold-proposer-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...proposer, subjectId: `hold-checker-${suffix}` };
  const student = await students.create({ idempotencyKey: randomUUID(),
    subjectId: `hold-student-${suffix}`, displayName: 'Synthetic Held Student', scopeType: 'organization',
    scopeId, sourceSystem: 'synthetic-admissions', sourceKey: `hold-source-${suffix}`,
    sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
    sourceRowSha256: '5'.repeat(64) }, proposer);
  const proposed = await holds.propose({ studentId: student.id, holdKey: `DOCUMENT-${suffix}`,
    effect: 'REGISTRATION_SUBMISSION', policyReference: 'SYNTHETIC-VERIFICATION-ONLY',
    reason: 'Synthetic missing evidence', evidenceReference: `SYNTHETIC-EVIDENCE-${suffix}`,
    scopeType: 'organization', scopeId }, proposer);
  let activationDisabled = false;
  try { await disabledHolds.activate(proposed.id, { expectedVersion: 1 }, checker); }
  catch (error) { activationDisabled = error instanceof ForbiddenException; }
  if (!activationDisabled) throw new Error('Hold activation bypassed disabled gate');
  let makerChecker = false;
  try { await holds.activate(proposed.id, { expectedVersion: 1 }, proposer); }
  catch (error) { makerChecker = error instanceof ForbiddenException; }
  if (!makerChecker) throw new Error('Hold proposer activated own hold');
  await holds.activate(proposed.id, { expectedVersion: 1 }, checker);
  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `hold-${suffix}`, version: 1,
    title: 'Synthetic hold period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, proposer);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, proposer);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `HOLD-${suffix}`, courseKey: `COURSE-${suffix}`, title: 'Synthetic hold course',
    capacity: 2, scopeType: 'organization', scopeId }, proposer);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, proposer);
  const requestInput = () => ({ studentId: student.id, periodId: period.id, offeringIds: [offering.id],
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId });
  let enforced = false;
  try { await registration.submit(requestInput(), proposer); }
  catch (error) { enforced = error instanceof ConflictException; }
  if (!enforced) throw new Error('Active registration hold was not enforced');
  await registrationWithoutEnforcement.submit(requestInput(), proposer);
  await holds.release(proposed.id, { expectedVersion: 2, reason: 'Synthetic evidence resolved',
    evidenceReference: `SYNTHETIC-RELEASE-${suffix}` }, checker);
  await registration.submit(requestInput(), proposer);
  let mutationRejected = false;
  try { await dataSource.query("UPDATE student.holds SET reason='tampered' WHERE id=$1", [proposed.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Student hold evidence was mutable');
  const rows = await dataSource.query(`SELECT h.status,h.version,h.raised_by,h.activated_by,r.released_by,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='student-hold' AND resource_id=h.id::text) audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='student-hold' AND aggregate_id=h.id::text) events
    FROM student.holds h JOIN student.hold_releases r ON r.hold_id=h.id WHERE h.id=$1`, [proposed.id]);
  const proof = rows[0];
  if (proof?.status !== 'RELEASED' || proof?.version !== 3 || proof?.raised_by === proof?.activated_by
    || proof?.raised_by === proof?.released_by || proof?.audits !== 3 || proof?.events !== 2) {
    throw new Error('Student hold activation, release, segregation, audit, or event evidence is incomplete');
  }
  process.stdout.write('Student hold scope, disabled gate, maker-checker activation, explicit enforcement toggle, append-only release, registration blocking/recovery, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
