import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RegistrationService } from '../apps/api/dist/modules/registration/registration.service.js';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Timetable verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: (key) => !['REGISTRATION_WINDOW_ENFORCEMENT_ENABLED',
    'REGISTRATION_ELIGIBILITY_ENFORCEMENT_ENABLED'].includes(key) };
  const disabledConfig = { get: () => false };
  const registration = new RegistrationService(dataSource, policy, evidence, enabledConfig);
  const timetable = new TimetableService(dataSource, policy, evidence, enabledConfig);
  const disabled = new TimetableService(dataSource, policy, evidence, disabledConfig);
  const owner = { subjectId: `timetable-owner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const outsider = { ...owner, subjectId: `timetable-outsider-${suffix}`,
    scopes: { organization: [randomUUID()] } };
  const now = Date.now();
  const period = await registration.createPeriod({ periodKey: `timetable-${suffix}`, version: 1,
    title: 'Synthetic timetable period', startsAt: new Date(now + 86_400_000).toISOString(),
    endsAt: new Date(now + 172_800_000).toISOString(), scopeType: 'organization', scopeId }, owner);
  await registration.publishPeriod(period.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const offerings = [];
  for (const key of ['A','B','C']) {
    const offering = await registration.createOffering({ periodId: period.id,
      offeringKey: `${key}-${suffix}`, courseKey: `COURSE-${key}-${suffix}`,
      title: `Synthetic section ${key}`, capacity: 10, scopeType: 'organization', scopeId }, owner);
    await registration.publishOffering(offering.id, { expectedRecordVersion: 1 }, owner);
    offerings.push(offering);
  }
  const meetingInput = (offeringId, meetingKey, startMinute, endMinute, roomKey, instructorSubjectId) => ({
    offeringId, meetingKey, weekday: 1, startMinute, endMinute, roomKey, instructorSubjectId,
    scopeType: 'organization', scopeId });
  const first = await timetable.create(meetingInput(offerings[0].id, `M1-${suffix}`, 600, 660,
    `ROOM-${suffix}`, `INSTRUCTOR-${suffix}`), owner);
  let publicationDisabled = false;
  try { await disabled.publish(first.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner); }
  catch (error) { publicationDisabled = error instanceof ForbiddenException; }
  if (!publicationDisabled) throw new Error('Timetable publication bypassed disabled gate');
  let scopeDenied = false;
  try { await timetable.publish(first.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Timetable publication ignored scope');
  await timetable.publish(first.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  const roomConflict = await timetable.create(meetingInput(offerings[1].id, `M2-${suffix}`, 630, 690,
    `ROOM-${suffix}`, `OTHER-${suffix}`), owner);
  let roomRejected = false;
  try { await timetable.publish(roomConflict.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner); }
  catch (error) { roomRejected = error instanceof ConflictException; }
  if (!roomRejected) throw new Error('Overlapping room booking was published');
  const instructorConflict = await timetable.create(meetingInput(offerings[2].id, `M3-${suffix}`, 620, 650,
    `OTHER-ROOM-${suffix}`, `INSTRUCTOR-${suffix}`), owner);
  let instructorRejected = false;
  try { await timetable.publish(instructorConflict.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner); }
  catch (error) { instructorRejected = error instanceof ConflictException; }
  if (!instructorRejected) throw new Error('Overlapping instructor booking was published');
  const boundary = await timetable.create(meetingInput(offerings[1].id, `M4-${suffix}`, 660, 720,
    `ROOM-${suffix}`, `OTHER-${suffix}`), owner);
  await timetable.publish(boundary.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, owner);
  let mutationRejected = false;
  try { await dataSource.query('UPDATE registration.timetable_meetings SET start_minute=601 WHERE id=$1', [first.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Published timetable meeting was mutable');
  const rows = await dataSource.query(`SELECT m.status,m.record_version,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='timetable-meeting'
      AND resource_id=m.id::text) audits,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='timetable-meeting'
      AND aggregate_id=m.id::text AND event_type='ScheduleChanged') payload
    FROM registration.timetable_meetings m WHERE m.id=$1`, [first.id]);
  const proof = rows[0];
  if (proof?.status !== 'PUBLISHED' || proof?.record_version !== 2 || proof?.audits !== 2
    || JSON.stringify(Object.keys(proof?.payload ?? {}).sort()) !== '["courseOfferingId","timetableMeetingId"]') {
    throw new Error('Timetable publication, audit, or minimum-data evidence is incomplete');
  }
  process.stdout.write('Timetable scope, publication gate, room/instructor overlap exclusion, boundary adjacency, immutability, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
