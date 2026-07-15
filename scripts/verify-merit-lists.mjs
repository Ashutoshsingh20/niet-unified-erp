import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { MeritListsService } from '../apps/api/dist/modules/admissions/merit-lists.service.js';
import { SeatMatricesService } from '../apps/api/dist/modules/admissions/seat-matrices.service.js';
import { StudentsService } from '../apps/api/dist/modules/students/students.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl }); await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Merit verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledKeys = new Set(['ADMISSION_DECISION_ENABLED', 'ADMISSION_MERIT_LIST_PUBLICATION_ENABLED',
    'ADMISSION_MERIT_SEAT_ENFORCEMENT_ENABLED', 'ADMISSION_SEAT_MATRIX_PUBLICATION_ENABLED',
    'ADMISSION_SEAT_RESERVATION_ENABLED']);
  const config = { get: (key) => enabledKeys.has(key) };
  const students = new StudentsService(dataSource, policy, evidence);
  const admissions = new AdmissionsService(dataSource, policy, evidence, config, students);
  const meritLists = new MeritListsService(dataSource, policy, evidence, config);
  const disabledMeritLists = new MeritListsService(dataSource, policy, evidence, { get: () => false });
  const seats = new SeatMatricesService(dataSource, policy, evidence, config);
  const applicant = { subjectId: `merit-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const maker = { ...applicant, subjectId: `merit-maker-${suffix}` };
  const checker = { ...applicant, subjectId: `merit-checker-${suffix}` };
  const outsider = { ...maker, subjectId: `merit-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const programmeKey = `MERIT-PROGRAMME-${suffix}`; const cycleKey = `CYCLE-${suffix}`;
  const policyReference = 'SYNTHETIC-MERIT-POLICY';

  async function offered(label) {
    const draft = await admissions.create({ applicantSubjectId: applicant.subjectId, programmeKey,
      encryptedPayloadBase64: randomBytes(64).toString('base64'), encryptionKeyReference: 'synthetic-merit-key',
      payloadSha256: randomUUID().replaceAll('-', '').repeat(2), idempotencyKey: randomUUID(),
      scopeType: 'organization', scopeId }, applicant);
    await admissions.submit(draft.id, { expectedVersion: 1, evidenceManifestSha256: 'a'.repeat(64) }, applicant);
    await admissions.decide(draft.id, { outcome: 'OFFERED', evaluationEngine: 'synthetic-eligibility',
      evaluationVersion: 'v1', regulationReference: policyReference,
      evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE', label }, reason: 'Synthetic eligibility evidence',
      expectedVersion: 2 }, maker);
    return draft.id;
  }
  const firstApplication = await offered('first'); const secondApplication = await offered('second');
  const listInput = { listKey: `synthetic.merit.${suffix}`, version: 1,
    title: 'Synthetic admissions merit list', programmeKey, cycleKey, scopeType: 'organization', scopeId,
    idempotencyKey: randomUUID(), evaluationEngine: 'synthetic-ranking', evaluationVersion: 'v1',
    policyReference, sourceEvidenceReference: 'SYNTHETIC-INPUT-EVIDENCE', entries: [
      { applicationId: firstApplication, meritRank: 1, allocationOrder: 1, categoryKey: 'general',
        scoreDisplay: 'Synthetic score A', evaluationTrace: { inputs: ['SYNTHETIC-A'], result: 'RANKED' },
        reason: 'Synthetic first ranking evidence' },
      { applicationId: secondApplication, meritRank: 2, allocationOrder: 2, categoryKey: 'alternate',
        scoreDisplay: 'Synthetic score B', evaluationTrace: { inputs: ['SYNTHETIC-B'], result: 'RANKED' },
        reason: 'Synthetic second ranking evidence' },
    ] };
  const creations = await Promise.all([meritLists.create(listInput, maker), meritLists.create(listInput, maker)]);
  const meritList = creations.find((result) => !result.replayed);
  if (meritList === undefined || creations.filter((result) => result.replayed).length !== 1
    || creations.some((result) => result.id !== meritList.id)) throw new Error('Concurrent merit list replay failed');
  let changedReplayRejected = false;
  try { await meritLists.create({ ...listInput, title: 'Changed synthetic merit list' }, maker); }
  catch (error) { changedReplayRejected = error instanceof ConflictException; }
  if (!changedReplayRejected) throw new Error('Changed merit list replay was accepted');
  const publication = { expectedRecordVersion: 1, publicationReference: 'SYNTHETIC-PUBLICATION-APPROVAL' };
  let disabledPublication = false;
  try { await disabledMeritLists.publish(meritList.id, publication, checker); }
  catch (error) { disabledPublication = error instanceof ForbiddenException; }
  if (!disabledPublication) throw new Error('Merit publication bypassed disabled gate');
  let makerDenied = false;
  try { await meritLists.publish(meritList.id, publication, maker); }
  catch (error) { makerDenied = error instanceof ForbiddenException; }
  if (!makerDenied) throw new Error('Merit list maker published it');
  let scopeDenied = false;
  try { await meritLists.publish(meritList.id, publication, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Merit publication ignored scope');
  await meritLists.publish(meritList.id, publication, checker);
  if (!(await meritLists.publish(meritList.id, publication, checker)).replayed) {
    throw new Error('Merit publication replay failed');
  }
  const published = await meritLists.get(meritList.id, checker);
  if (published.status !== 'PUBLISHED' || published.recordVersion !== 2 || published.entries.length !== 2
    || published.entries[0]?.applicationId !== firstApplication) throw new Error('Published merit list read is invalid');
  let entryMutationRejected = false;
  try { await dataSource.query("UPDATE admissions.merit_list_entries SET score_display='tampered' WHERE id=$1",
    [published.entries[0].id]); } catch { entryMutationRejected = true; }
  if (!entryMutationRejected) throw new Error('Published merit entry was mutable');

  const matrixInput = { matrixKey: `synthetic.merit.seats.${suffix}`, version: 1,
    title: 'Synthetic merit-linked seat matrix', programmeKey, cycleKey, scopeType: 'organization', scopeId,
    idempotencyKey: randomUUID(), categories: [
      { categoryKey: 'general', title: 'Synthetic general category', capacity: 2, allocationOrder: 1 },
      { categoryKey: 'alternate', title: 'Synthetic alternate category', capacity: 1, allocationOrder: 2 },
    ] };
  const matrix = await seats.create(matrixInput, maker);
  await seats.publish(matrix.id, { expectedRecordVersion: 1, policyDecisionReference: policyReference }, checker);
  const reservationInput = { applicationId: firstApplication, categoryKey: 'general',
    idempotencyKey: randomUUID(), expectedMatrixRecordVersion: 2,
    evaluationEngine: 'synthetic-seat-allocation', evaluationVersion: 'v1', policyReference,
    evaluationTrace: { result: 'SYNTHETIC_MERIT_MATCH' }, reason: 'Synthetic merit allocation evidence' };
  let missingMeritRejected = false;
  try { await seats.reserve(matrix.id, reservationInput, maker); }
  catch (error) { missingMeritRejected = error instanceof ConflictException; }
  if (!missingMeritRejected) throw new Error('Seat reservation bypassed merit enforcement');
  let wrongMeritRejected = false;
  try { await seats.reserve(matrix.id, { ...reservationInput, idempotencyKey: randomUUID(),
    meritEntryId: published.entries[1].id }, maker); }
  catch (error) { wrongMeritRejected = error instanceof ConflictException; }
  if (!wrongMeritRejected) throw new Error('Seat reservation accepted another application merit entry');
  const linkedInput = { ...reservationInput, idempotencyKey: randomUUID(),
    meritEntryId: published.entries[0].id };
  const reservation = await seats.reserve(matrix.id, linkedInput, maker);
  const replay = await seats.reserve(matrix.id, linkedInput, maker);
  if (!replay.replayed || replay.id !== reservation.id) throw new Error('Merit-linked reservation replay failed');
  let meritReuseRejected = false;
  try { await dataSource.query(`INSERT INTO admissions.merit_entry_seat_reservations
    (merit_entry_id,reservation_id) VALUES ($1,$2)`, [published.entries[0].id, randomUUID()]); }
  catch { meritReuseRejected = true; }
  if (!meritReuseRejected) throw new Error('Merit entry was linked to a second reservation');
  const proofRows = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM admissions.merit_entry_seat_reservations
      WHERE merit_entry_id=$1 AND reservation_id=$2) links,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-merit-list'
      AND resource_id=$3::text) audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-merit-list'
      AND aggregate_id=$3::text) events`, [published.entries[0].id, reservation.id, meritList.id]);
  if (proofRows[0]?.links !== 1 || proofRows[0]?.audits !== 2 || proofRows[0]?.events !== 1) {
    throw new Error('Merit publication or reservation-link evidence is incomplete');
  }
  process.stdout.write('Versioned evidence-backed merit lists, concurrent replay, maker-checker publication, scope, immutability, ordered reads, gated merit-to-seat enforcement, exact linking, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
