import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationCapacityService } from '../apps/api/dist/modules/registration/registration-capacity.service.js';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Capacity verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID(); const now = Date.now();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED',
    'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED', 'WAITLIST_EXPIRY_ENFORCEMENT_ENABLED'].includes(key) };
  const disabled = { get: () => false };
  const registration = new RegistrationService(dataSource, policy, evidence, enabled);
  const capacity = new RegistrationCapacityService(dataSource, policy, evidence, enabled);
  const disabledCapacity = new RegistrationCapacityService(dataSource, policy, evidence, disabled);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabled);
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `capacity-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `capacity-checker-${suffix}` };
  const actors = Array.from({ length: 6 }, (_, index) => ({ ...maker,
    subjectId: `capacity-student-${index}-${suffix}` }));
  const records = [];
  for (let index = 0; index < actors.length; index += 1) {
    records.push(await students.create({ idempotencyKey: randomUUID(), subjectId: actors[index].subjectId,
      displayName: `Synthetic capacity student ${index}`, scopeType: 'organization', scopeId,
      sourceSystem: 'synthetic-registration', sourceKey: `capacity-${index}-${suffix}`,
      sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
      sourceRowSha256: String(index + 1).repeat(64).slice(0, 64) }, maker));
  }
  const period = await registration.createPeriod({ periodKey: `capacity-${suffix}`, version: 1,
    title: 'Synthetic reserved capacity period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, maker);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-CAPACITY-POLICY' }, maker);
  const offering = await registration.createOffering({ periodId: period.id,
    offeringKey: `CAPACITY-${suffix}`, courseKey: `COURSE-${suffix}`,
    title: 'Synthetic reserved-capacity offering', capacity: 3,
    scopeType: 'organization', scopeId }, maker);
  await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, maker);
  const poolInput = { offeringId: offering.id, poolKey: `synthetic-reserved-${suffix}`, version: 1,
    title: 'Synthetic reserved capacity', capacity: 2, idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId };
  const pool = await capacity.createPool(poolInput, maker);
  const poolReplay = await capacity.createPool(poolInput, maker);
  if (!poolReplay.replayed || poolReplay.id !== pool.id) throw new Error('Capacity pool replay failed');
  const publication = { expectedRecordVersion: 1, policyDecisionReference: 'SYNTHETIC-CAPACITY-POLICY' };
  await expectForbidden(() => disabledCapacity.publishPool(pool.id, publication, checker),
    'Capacity pool bypassed disabled publication gate');
  await expectForbidden(() => capacity.publishPool(pool.id, publication, maker),
    'Capacity pool creator published it');
  await capacity.publishPool(pool.id, publication, checker);
  const excessive = await capacity.createPool({ ...poolInput, poolKey: `synthetic-excess-${suffix}`,
    version: 2, capacity: 2, idempotencyKey: randomUUID() }, maker);
  await expectConflict(() => capacity.publishPool(excessive.id, publication, checker),
    'Published reserved pools exceeded offering capacity');
  const entitlementIds = [];
  for (let index = 2; index < records.length; index += 1) {
    const input = { studentId: records[index].id, poolId: pool.id, idempotencyKey: randomUUID(),
      policyReference: 'SYNTHETIC-CAPACITY-POLICY', evidenceReference: `SYNTHETIC-ELIGIBILITY-${index}`,
      evaluationEngine: 'synthetic-capacity-evaluator', evaluationVersion: 'v1',
      evaluationTrace: { syntheticStudentIndex: index }, reason: 'Synthetic reserved-pool eligibility',
      scopeType: 'organization', scopeId };
    const entitlement = await capacity.createEntitlement(input, maker);
    if (index === 2) {
      const replay = await capacity.createEntitlement(input, maker);
      if (!replay.replayed || replay.id !== entitlement.id) throw new Error('Entitlement replay failed');
      await expectForbidden(() => disabledCapacity.decideEntitlement(entitlement.id,
        { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker), 'Entitlement bypassed disabled gate');
      await expectForbidden(() => capacity.decideEntitlement(entitlement.id,
        { outcome: 'APPROVED', expectedRecordVersion: 1 }, maker), 'Entitlement requester approved it');
    }
    await capacity.decideEntitlement(entitlement.id,
      { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker);
    entitlementIds.push(entitlement.id);
  }
  const regulation = await curriculum.create({ regulationKey: `capacity-${suffix}`, version: 1,
    title: 'Synthetic capacity regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC' },
    impactSummary: 'Synthetic reserved-capacity verification evidence.' }, maker);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-CAPACITY-POLICY' }, maker);
  const decision = { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-capacity-decision', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC' }, reason: 'Synthetic capacity decision', expectedVersion: 1 };
  const submit = (index, entitlementId) => ({ studentId: records[index].id, periodId: period.id,
    offeringIds: [offering.id], idempotencyKey: randomUUID(), scopeType: 'organization', scopeId,
    ...(entitlementId === undefined ? {} : { capacityAssignments: [{ offeringId: offering.id,
      poolId: pool.id, entitlementId }] }) });
  const general = await registration.submit(submit(0), actors[0]);
  await registration.decide(general.id, decision, checker);
  const blockedGeneral = await registration.submit(submit(1), actors[1]);
  await expectConflict(() => registration.decide(blockedGeneral.id, decision, checker),
    'General registration consumed reserved capacity');
  const firstReservedInput = submit(2, entitlementIds[0]);
  const firstReserved = await registration.submit(firstReservedInput, actors[2]);
  const firstReplay = await registration.submit(firstReservedInput, actors[2]);
  if (!firstReplay.replayed || firstReplay.id !== firstReserved.id) throw new Error('Pool assignment replay failed');
  await registration.decide(firstReserved.id, decision, checker);
  await expectConflict(() => registration.submit({ ...submit(3, entitlementIds[0]),
    studentId: records[3].id }, actors[3]), 'Entitlement was accepted for the wrong student');
  const pending = await Promise.all([registration.submit(submit(3, entitlementIds[1]), actors[3]),
    registration.submit(submit(4, entitlementIds[2]), actors[4])]);
  const outcomes = await Promise.allSettled(pending.map((item) => registration.decide(item.id, decision, checker)));
  if (outcomes.filter((item) => item.status === 'fulfilled').length !== 1
    || outcomes.filter((item) => item.status === 'rejected'
      && item.reason instanceof ConflictException).length !== 1) {
    throw new Error('Concurrent reserved-capacity confirmation was not serialized');
  }
  const winnerIndex = outcomes.findIndex((item) => item.status === 'fulfilled');
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  await registration.withdraw(pending[winnerIndex].id,
    { reason: 'Synthetic reserved capacity release', expectedVersion: 2 }, actors[winnerIndex + 3]);
  await registration.decide(pending[loserIndex].id, decision, checker);
  const proof = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM registration.confirmed_item_allocations
      WHERE offering_id=$1 AND pool_id IS NULL) general_count,
    (SELECT count(*)::int FROM registration.confirmed_item_allocations
      WHERE offering_id=$1 AND pool_id=$2) reserved_count,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type IN ('registration-capacity-pool','registration-capacity-entitlement')
        AND aggregate_id IN ($2::text,$3::text)) events`,
  [offering.id, pool.id, entitlementIds[0]]);
  if (proof[0]?.general_count !== 1 || proof[0]?.reserved_count !== 2 || proof[0]?.events !== 2) {
    throw new Error('Reserved/general allocation or lifecycle evidence is incomplete');
  }
  let mutationRejected = false;
  try { await dataSource.query('UPDATE registration.capacity_pools SET capacity=3 WHERE id=$1', [pool.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Published capacity pool was mutable');
  process.stdout.write('Versioned offering capacity pools, maker-checker publication and entitlements, exact replay, reserved/general isolation, total-capacity bounds, wrong-student denial, concurrent confirmation serialization, withdrawal release, projection integrity, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }

async function expectConflict(action, message) {
  try { await action(); } catch (error) { if (error instanceof ConflictException) return; throw error; }
  throw new Error(message);
}
async function expectForbidden(action, message) {
  try { await action(); } catch (error) { if (error instanceof ForbiddenException) return; throw error; }
  throw new Error(message);
}
