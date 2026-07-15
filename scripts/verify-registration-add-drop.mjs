import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { RegistrationAddDropService } from '../apps/api/dist/modules/registration/registration-add-drop.service.js';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Add/drop verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID(); const now = Date.now();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = { get: (key) => key !== 'REGISTRATION_WINDOW_ENFORCEMENT_ENABLED'
    && key !== 'REGISTRATION_RESERVED_CAPACITY_ENFORCEMENT_ENABLED'
    && key !== 'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED'
    && key !== 'WAITLIST_EXPIRY_ENFORCEMENT_ENABLED' };
  const disabled = { get: () => false };
  const registration = new RegistrationService(dataSource, policy, evidence, enabled);
  const addDrop = new RegistrationAddDropService(dataSource, policy, evidence, enabled);
  const capacity = new RegistrationCapacityService(dataSource, policy, evidence, enabled);
  const disabledAddDrop = new RegistrationAddDropService(dataSource, policy, evidence, disabled);
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabled);
  const students = new StudentsService(dataSource, policy, evidence);
  const maker = { subjectId: `add-drop-maker-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const checker = { ...maker, subjectId: `add-drop-checker-${suffix}` };
  const actors = Array.from({ length: 3 }, (_, index) => ({ ...maker,
    subjectId: `add-drop-student-${index}-${suffix}` }));
  const records = [];
  for (let index = 0; index < actors.length; index += 1) {
    records.push(await students.create({ idempotencyKey: randomUUID(), subjectId: actors[index].subjectId,
      displayName: `Synthetic add drop student ${index}`, scopeType: 'organization', scopeId,
      sourceSystem: 'synthetic-registration', sourceKey: `add-drop-${index}-${suffix}`,
      sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
      sourceRowSha256: String(index + 2).repeat(64).slice(0, 64) }, maker));
  }
  const period = await registration.createPeriod({ periodKey: `add-drop-${suffix}`, version: 1,
    title: 'Synthetic add drop period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, maker);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-ADD-DROP-POLICY' }, maker);
  const createOffering = async (key, capacity = 10) => {
    const offering = await registration.createOffering({ periodId: period.id,
      offeringKey: `${key}-${suffix}`, courseKey: `${key}-COURSE-${suffix}`,
      title: `Synthetic ${key} offering`, capacity, scopeType: 'organization', scopeId }, maker);
    await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, maker);
    return offering;
  };
  const [offeringA, offeringB, offeringC, offeringD, contested] = await Promise.all([
    createOffering('ADD-DROP-A'), createOffering('ADD-DROP-B'), createOffering('ADD-DROP-C'),
    createOffering('ADD-DROP-D'), createOffering('ADD-DROP-CONTESTED', 1),
  ]);
  const regulation = await curriculum.create({ regulationKey: `add-drop-${suffix}`, version: 1,
    title: 'Synthetic add drop regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC' },
    impactSummary: 'Synthetic add/drop verification evidence.' }, maker);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-ADD-DROP-POLICY' }, maker);
  const registrationDecision = { outcome: 'CONFIRMED', regulationId: regulation.id,
    evaluationEngine: 'synthetic-registration-evaluator', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC' }, reason: 'Synthetic confirmed registration', expectedVersion: 1 };
  const submitBase = async (studentIndex, offeringIds) => {
    const request = await registration.submit({ studentId: records[studentIndex].id, periodId: period.id,
      offeringIds, idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, actors[studentIndex]);
    await registration.decide(request.id, registrationDecision, checker);
    return request;
  };
  const [base0, base1, base2] = await Promise.all([
    submitBase(0, [offeringA.id, offeringD.id]), submitBase(1, [offeringA.id]),
    submitBase(2, [offeringB.id]),
  ]);
  const pool = await capacity.createPool({ offeringId: offeringC.id,
    poolKey: `add-drop-reserved-${suffix}`, version: 1, title: 'Synthetic add drop reserved pool',
    capacity: 5, idempotencyKey: randomUUID(), scopeType: 'organization', scopeId }, maker);
  await capacity.publishPool(pool.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-ADD-DROP-POLICY' }, checker);
  const entitlement = await capacity.createEntitlement({ studentId: records[0].id, poolId: pool.id,
    idempotencyKey: randomUUID(), policyReference: 'SYNTHETIC-ADD-DROP-POLICY',
    evidenceReference: 'SYNTHETIC-ADD-DROP-RESERVED-ELIGIBILITY',
    evaluationEngine: 'synthetic-add-drop-capacity', evaluationVersion: 'v1',
    evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' }, reason: 'Synthetic reserved add/drop eligibility',
    scopeType: 'organization', scopeId }, maker);
  await capacity.decideEntitlement(entitlement.id,
    { outcome: 'APPROVED', expectedRecordVersion: 1 }, checker);
  const eligibilitySnapshot = { requestedCreditUnits: '8.00', maximumCreditUnits: '24.00',
    adviserRequired: false, evaluationEngine: 'synthetic-add-drop-eligibility', evaluationVersion: 'v1',
    policyReference: 'SYNTHETIC-ADD-DROP-POLICY', evaluationTrace: { source: 'SYNTHETIC' } };
  const swapInput = { registrationRequestId: base0.id,
    beforeOfferingIds: [offeringA.id, offeringD.id], afterOfferingIds: [offeringC.id, offeringD.id],
    idempotencyKey: randomUUID(), scopeType: 'organization', scopeId, eligibilitySnapshot,
    capacityAssignments: [{ offeringId: offeringC.id, poolId: pool.id, entitlementId: entitlement.id }] };
  await expectForbidden(() => disabledAddDrop.create(swapInput, actors[0]),
    'Add/drop request bypassed disabled policy gate');
  const swap = await addDrop.create(swapInput, actors[0]);
  const replay = await addDrop.create(swapInput, actors[0]);
  if (!replay.replayed || replay.id !== swap.id) throw new Error('Add/drop exact replay failed');
  const decision = { outcome: 'APPROVED', evaluationEngine: 'synthetic-add-drop-decision',
    evaluationVersion: 'v1', evaluationTrace: { result: 'SYNTHETIC' },
    reason: 'Synthetic add/drop approval', expectedVersion: 1 };
  await expectForbidden(() => addDrop.decide(swap.id, decision, actors[0]),
    'Add/drop requester approved the same request');
  await addDrop.decide(swap.id, decision, checker);
  const swapped = await dataSource.query(`SELECT offering_id FROM registration.confirmed_item_allocations
    WHERE request_id=$1 ORDER BY offering_id`, [base0.id]);
  if (JSON.stringify(swapped.map((row) => row.offering_id))
    !== JSON.stringify([offeringC.id, offeringD.id].sort())) throw new Error('Atomic add/drop swap failed');
  const reservedAllocation = await dataSource.query(`SELECT pool_id,add_drop_request_id
    FROM registration.confirmed_item_allocations WHERE request_id=$1 AND offering_id=$2`,
  [base0.id, offeringC.id]);
  if (reservedAllocation[0]?.pool_id !== pool.id || reservedAllocation[0]?.add_drop_request_id !== swap.id) {
    throw new Error('Reserved-capacity add/drop allocation provenance is incomplete');
  }
  await expectConflict(() => addDrop.create({ ...swapInput, idempotencyKey: randomUUID() }, actors[0]),
    'Stale add/drop before manifest was accepted');
  const rejected = await addDrop.create({ ...swapInput, beforeOfferingIds: [offeringC.id, offeringD.id],
    afterOfferingIds: [offeringD.id], capacityAssignments: [], idempotencyKey: randomUUID() }, actors[0]);
  await addDrop.decide(rejected.id, { ...decision, outcome: 'REJECTED', reason: 'Synthetic rejection' }, checker);
  const makeContender = (base, actorIndex, beforeOfferingId) => addDrop.create({
    registrationRequestId: base.id, beforeOfferingIds: [beforeOfferingId],
    afterOfferingIds: [beforeOfferingId, contested.id], idempotencyKey: randomUUID(),
    scopeType: 'organization', scopeId, eligibilitySnapshot }, actors[actorIndex]);
  const contenders = await Promise.all([makeContender(base1, 1, offeringA.id),
    makeContender(base2, 2, offeringB.id)]);
  const outcomes = await Promise.allSettled(contenders.map((item) => addDrop.decide(item.id, decision, checker)));
  if (outcomes.filter((item) => item.status === 'fulfilled').length !== 1
    || outcomes.filter((item) => item.status === 'rejected'
      && item.reason instanceof ConflictException).length !== 1) {
    throw new Error('Concurrent add/drop capacity approval was not serialized');
  }
  const proof = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM registration.add_drop_allocation_events
      WHERE add_drop_request_id=$1) swap_events,
    (SELECT count(*)::int FROM registration.add_drop_decisions
      WHERE add_drop_request_id IN ($1,$2)) decisions,
    (SELECT count(*)::int FROM platform.outbox_events
      WHERE aggregate_type='registration-add-drop' AND aggregate_id IN ($1::text,$2::text)) events`,
  [swap.id, rejected.id]);
  if (proof[0]?.swap_events !== 2 || proof[0]?.decisions !== 2 || proof[0]?.events !== 4) {
    throw new Error('Add/drop decision, allocation, or outbox evidence is incomplete');
  }
  let mutationRejected = false;
  try { await dataSource.query(`UPDATE registration.add_drop_manifest_items SET manifest_side='AFTER'
    WHERE add_drop_request_id=$1 AND manifest_side='BEFORE'`, [swap.id]); } catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Add/drop before evidence was mutable');
  let incompleteRejected = false;
  try {
    await dataSource.query('BEGIN');
    await dataSource.query(`INSERT INTO registration.add_drop_requests
      (id,registration_request_id,student_id,period_id,scope_type,scope_id,before_manifest_sha256,
       after_manifest_sha256,before_item_count,after_item_count,idempotency_key,requested_by)
      VALUES ($1,$2,$3,$4,'organization',$5,$6,$7,1,1,$8,$9)`, [randomUUID(), base0.id,
      records[0].id, period.id, scopeId, '0'.repeat(64), '1'.repeat(64), randomUUID(), actors[0].subjectId]);
    await dataSource.query('COMMIT');
  } catch {
    incompleteRejected = true;
    await dataSource.query('ROLLBACK');
  }
  if (!incompleteRejected) throw new Error('Incomplete add/drop evidence committed directly');
  process.stdout.write('Immutable before/after manifests, exact replay, policy gate, maker-checker decision, stale-state rejection, atomic swaps, reserved-capacity provenance, rejection isolation, concurrent capacity serialization, allocation events, audit, outbox, and database immutability verified\n');
} finally { await dataSource.destroy(); }

async function expectConflict(action, message) {
  try { await action(); } catch (error) { if (error instanceof ConflictException) return; throw error; }
  throw new Error(message);
}
async function expectForbidden(action, message) {
  try { await action(); } catch (error) { if (error instanceof ForbiddenException) return; throw error; }
  throw new Error(message);
}
