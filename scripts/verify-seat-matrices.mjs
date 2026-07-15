import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Seat verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const students = new StudentsService(dataSource, policy, evidence);
  const enabledKeys = new Set(['ADMISSION_DECISION_ENABLED', 'ADMISSION_OFFER_LIFECYCLE_ENABLED',
    'ADMISSION_CANCELLATION_ENABLED', 'STUDENT_CONVERSION_ENABLED', 'ADMISSION_SEAT_MATRIX_PUBLICATION_ENABLED',
    'ADMISSION_SEAT_RESERVATION_ENABLED', 'ADMISSION_SEAT_ENFORCEMENT_ENABLED']);
  const config = { get: (key) => enabledKeys.has(key) };
  const admissions = new AdmissionsService(dataSource, policy, evidence, config, students);
  const seats = new SeatMatricesService(dataSource, policy, evidence, config);
  const disabledSeats = new SeatMatricesService(dataSource, policy, evidence, { get: () => false });
  const applicant = { subjectId: `seat-applicant-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const maker = { ...applicant, subjectId: `seat-maker-${suffix}` };
  const checker = { ...applicant, subjectId: `seat-checker-${suffix}` };
  const outsider = { ...maker, subjectId: `seat-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const programmeKey = `SEAT-PROGRAMME-${suffix}`; const policyReference = 'SYNTHETIC-SEAT-POLICY';
  const matrixInput = { matrixKey: `synthetic.seats.${suffix}`, version: 1,
    title: 'Synthetic admission seat matrix', programmeKey, cycleKey: `CYCLE-${suffix}`,
    scopeType: 'organization', scopeId, idempotencyKey: randomUUID(), categories: [
      { categoryKey: 'general', title: 'Synthetic general category', capacity: 1, allocationOrder: 1 },
      { categoryKey: 'alternate', title: 'Synthetic alternate category', capacity: 1, allocationOrder: 2 },
    ] };
  const creations = await Promise.all([seats.create(matrixInput, maker), seats.create(matrixInput, maker)]);
  const matrix = creations.find((result) => !result.replayed);
  if (matrix === undefined || creations.filter((result) => result.replayed).length !== 1
    || creations.some((result) => result.id !== matrix.id)) throw new Error('Concurrent seat matrix replay failed');
  const publication = { expectedRecordVersion: 1, policyDecisionReference: policyReference };
  let disabledPublication = false;
  try { await disabledSeats.publish(matrix.id, publication, checker); }
  catch (error) { disabledPublication = error instanceof ForbiddenException; }
  if (!disabledPublication) throw new Error('Seat matrix publication bypassed disabled gate');
  let makerDenied = false;
  try { await seats.publish(matrix.id, publication, maker); }
  catch (error) { makerDenied = error instanceof ForbiddenException; }
  if (!makerDenied) throw new Error('Seat matrix maker published it');
  let scopeDenied = false;
  try { await seats.publish(matrix.id, publication, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Seat matrix publication ignored scope');
  await seats.publish(matrix.id, publication, checker);
  const replayPublication = await seats.publish(matrix.id, publication, checker);
  if (!replayPublication.replayed) throw new Error('Seat matrix publication replay failed');
  let lateCategoryRejected = false;
  try { await dataSource.query(`INSERT INTO admissions.seat_categories
    (id,matrix_id,category_key,title,capacity,allocation_order)
    VALUES ($1,$2,'late','Late category',1,3)`, [randomUUID(), matrix.id]); }
  catch { lateCategoryRejected = true; }
  if (!lateCategoryRejected) throw new Error('Published seat matrix accepted another category');

  async function offered(label) {
    const draft = await admissions.create({ applicantSubjectId: applicant.subjectId, programmeKey,
      encryptedPayloadBase64: randomBytes(64).toString('base64'), encryptionKeyReference: 'synthetic-seat-key',
      payloadSha256: randomUUID().replaceAll('-', '').repeat(2), idempotencyKey: randomUUID(),
      scopeType: 'organization', scopeId }, applicant);
    await admissions.submit(draft.id, { expectedVersion: 1, evidenceManifestSha256: 'a'.repeat(64) }, applicant);
    await admissions.decide(draft.id, { outcome: 'OFFERED', evaluationEngine: 'synthetic-eligibility',
      evaluationVersion: 'v1', regulationReference: policyReference,
      evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE', label }, reason: 'Synthetic seat eligibility',
      expectedVersion: 2 }, maker);
    return draft.id;
  }
  const firstApplication = await offered('first'); const secondApplication = await offered('second');
  const thirdApplication = await offered('third');
  const reserveInput = (applicationId) => ({ applicationId, categoryKey: 'general',
    idempotencyKey: randomUUID(), expectedMatrixRecordVersion: 2,
    evaluationEngine: 'synthetic-seat-allocation', evaluationVersion: 'v1', policyReference,
    evaluationTrace: { result: 'SYNTHETIC_CATEGORY_MATCH' }, reason: 'Synthetic category evidence' });
  let reservationDisabled = false;
  try { await disabledSeats.reserve(matrix.id, reserveInput(firstApplication), maker); }
  catch (error) { reservationDisabled = error instanceof ForbiddenException; }
  if (!reservationDisabled) throw new Error('Seat reservation bypassed disabled gate');
  const raceInputs = [reserveInput(firstApplication), reserveInput(secondApplication)];
  const race = await Promise.allSettled(raceInputs.map((input) => seats.reserve(matrix.id, input, maker)));
  const winnerIndex = race.findIndex((result) => result.status === 'fulfilled');
  if (winnerIndex < 0 || race.filter((result) => result.status === 'fulfilled').length !== 1
    || race.filter((result) => result.status === 'rejected'
      && result.reason instanceof ConflictException).length !== 1) {
    throw new Error('One-seat category did not enforce concurrent capacity');
  }
  const winnerApplication = winnerIndex === 0 ? firstApplication : secondApplication;
  const waitingApplication = winnerIndex === 0 ? secondApplication : firstApplication;
  const winnerInput = raceInputs[winnerIndex]; const winner = race[winnerIndex].value;
  const winnerReplay = await seats.reserve(matrix.id, winnerInput, maker);
  if (!winnerReplay.replayed || winnerReplay.id !== winner.id || winner.slotNumber !== 1) {
    throw new Error('Seat reservation replay failed');
  }
  let unreservedOfferRejected = false;
  try { await admissions.issueOffer(thirdApplication, { offerReference: `NO-SEAT-${suffix}`,
    termsManifestSha256: 'b'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference, expectedApplicationVersion: 3 }, maker); }
  catch (error) { unreservedOfferRejected = error instanceof ConflictException; }
  if (!unreservedOfferRejected) throw new Error('Offer issuance bypassed seat enforcement');
  const winnerOffer = await admissions.issueOffer(winnerApplication, { offerReference: `WINNER-${suffix}`,
    termsManifestSha256: 'c'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference, expectedApplicationVersion: 3, seatReservationId: winner.id }, maker);
  await admissions.declineOffer(winnerOffer.id, { expectedOfferVersion: 1,
    reason: 'Synthetic applicant declines reserved offer', policyReference }, applicant);
  const secondReservationInput = reserveInput(waitingApplication);
  const secondReservation = await seats.reserve(matrix.id, secondReservationInput, maker);
  if (secondReservation.slotNumber !== 1) throw new Error('Released seat slot was not reusable');
  const secondOffer = await admissions.issueOffer(waitingApplication, { offerReference: `CONVERT-${suffix}`,
    termsManifestSha256: 'd'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policyReference, expectedApplicationVersion: 3, seatReservationId: secondReservation.id }, maker);
  await admissions.acceptOffer(secondOffer.id, { expectedOfferVersion: 1 }, applicant);
  const conversion = await admissions.convert(secondOffer.id, { idempotencyKey: randomUUID(),
    displayName: 'Synthetic Seat Converted Student', mappingEngine: 'synthetic-mapper',
    mappingVersion: 'v1', mappingTrace: { result: 'SYNTHETIC_MAPPING' }, expectedOfferVersion: 2 }, checker);
  if (conversion.replayed) throw new Error('Seat conversion unexpectedly replayed');
  const cancellationReservation = await seats.reserve(matrix.id, { ...reserveInput(thirdApplication),
    categoryKey: 'alternate', idempotencyKey: randomUUID() }, maker);
  const cancellationOffer = await admissions.issueOffer(thirdApplication, {
    offerReference: `CANCEL-${suffix}`, termsManifestSha256: 'e'.repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policyReference,
    expectedApplicationVersion: 3, seatReservationId: cancellationReservation.id }, maker);
  await admissions.acceptOffer(cancellationOffer.id, { expectedOfferVersion: 1 }, applicant);
  const cancellationRequest = await admissions.requestCancellation(cancellationOffer.id, {
    idempotencyKey: randomUUID(), expectedOfferVersion: 2,
    reason: 'Synthetic cancellation releases reserved seat' }, applicant);
  const cancellation = await admissions.assessCancellation(cancellationRequest.id, {
    expectedRequestVersion: 1, decision: 'APPROVED', financialDisposition: 'NO_REFUND_REQUIRED',
    evaluationEngine: 'synthetic-cancellation', evaluationVersion: 'v1', policyReference,
    evaluationTrace: { result: 'SYNTHETIC_NO_REFUND' }, reason: 'Synthetic no-refund evidence' }, checker);
  if (cancellation.status !== 'CANCELLED') throw new Error('Cancellation did not close its reserved offer');
  const availability = await seats.availability(matrix.id, checker);
  const general = availability.items.find((item) => item.categoryKey === 'general');
  const alternate = availability.items.find((item) => item.categoryKey === 'alternate');
  if (general?.capacity !== 1 || general.reserved !== 0 || general.converted !== 1
    || general.available !== 0) {
    throw new Error('Seat availability did not derive terminal reservations correctly');
  }
  if (alternate?.capacity !== 1 || alternate.reserved !== 0 || alternate.converted !== 0
    || alternate.available !== 1) throw new Error('Cancelled offer did not release seat capacity');
  let reservationBypassRejected = false;
  try { await dataSource.query("UPDATE admissions.seat_reservations SET status='RELEASED',version=version+1 WHERE id=$1",
    [secondReservation.id]); } catch { reservationBypassRejected = true; }
  if (!reservationBypassRejected) throw new Error('Seat reservation transitioned without terminal evidence');
  const proofRows = await dataSource.query(`SELECT
    (SELECT count(*)::int FROM admissions.seat_releases
      WHERE reservation_id IN ($1,$4)) releases,
    (SELECT count(*)::int FROM admissions.seat_conversions WHERE reservation_id=$2) conversions,
    (SELECT status FROM admissions.seat_reservations WHERE id=$1) released_status,
    (SELECT status FROM admissions.seat_reservations WHERE id=$2) converted_status,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-seat-matrix'
      AND resource_id=$3::text) matrix_audits,
    (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_type='admission-seat-reservation'
      AND aggregate_id IN ($1::text,$2::text,$4::text)) reservation_events`,
  [winner.id, secondReservation.id, matrix.id, cancellationReservation.id]);
  const proof = proofRows[0];
  if (proof?.releases !== 2 || proof?.conversions !== 1 || proof?.released_status !== 'RELEASED'
    || proof?.converted_status !== 'CONVERTED' || proof?.matrix_audits !== 2
    || proof?.reservation_events !== 3) throw new Error('Seat lifecycle evidence is incomplete');
  process.stdout.write('Versioned seat matrix, maker-checker publication, canonical categories/slots, scoped availability, concurrent capacity exclusion, explainable reservation, offer enforcement, terminal release/reuse, conversion consumption, immutable evidence, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
