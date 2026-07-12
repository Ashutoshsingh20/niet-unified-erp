import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
import { ProgrammesService } from '../apps/api/dist/modules/programmes/programmes.service.js';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Programme verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabledConfig = { get: () => true }; const disabledConfig = { get: () => false };
  const curriculum = new CurriculumService(dataSource, policy, evidence, enabledConfig);
  const students = new StudentsService(dataSource, policy, evidence);
  const programmes = new ProgrammesService(dataSource, policy, evidence, enabledConfig);
  const disabled = new ProgrammesService(dataSource, policy, evidence, disabledConfig);
  const assigner = { subjectId: `programme-assigner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const activator = { ...assigner, subjectId: `programme-activator-${suffix}` };
  const student = await students.create({ idempotencyKey: randomUUID(),
    subjectId: `programme-student-${suffix}`, displayName: 'Synthetic Programme Student',
    scopeType: 'organization', scopeId, sourceSystem: 'synthetic-admissions',
    sourceKey: `programme-source-${suffix}`, sourceExtractedAt: new Date().toISOString(),
    mappingVersion: 'synthetic-v1', sourceRowSha256: '3'.repeat(64) }, assigner);
  const regulation = await curriculum.create({ regulationKey: `programme-${suffix}`, version: 1,
    title: 'Synthetic programme regulation', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-v1', ruleDocument: { kind: 'SYNTHETIC_EMPTY' },
    impactSummary: 'Synthetic regulation for programme history verification.' }, assigner);
  await curriculum.publish(regulation.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, assigner);
  const programme = await programmes.create({ programmeKey: `BTECH-${suffix}`, version: 1,
    title: 'Synthetic BTech programme', regulationId: regulation.id,
    structureManifestSha256: '4'.repeat(64), scopeType: 'organization', scopeId }, assigner);
  let publicationDisabled = false;
  try { await disabled.publish(programme.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, assigner); }
  catch (error) { publicationDisabled = error instanceof ForbiddenException; }
  if (!publicationDisabled) throw new Error('Programme publication bypassed disabled gate');
  await programmes.publish(programme.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, assigner);
  const assignment = { studentId: student.id, programmeVersionId: programme.id,
    startsOn: '2026-07-01', assignmentEngine: 'synthetic-mapper', assignmentVersion: 'v1',
    assignmentTrace: { result: 'SYNTHETIC_ASSIGNMENT' }, scopeType: 'organization', scopeId };
  const enrolment = await programmes.assign(assignment, assigner);
  let overlapRejected = false;
  try { await programmes.assign({ ...assignment, startsOn: '2027-01-01' }, assigner); }
  catch (error) { overlapRejected = error instanceof ConflictException; }
  if (!overlapRejected) throw new Error('Overlapping programme enrolment was accepted');
  let activationDisabled = false;
  try { await disabled.activate(enrolment.id, { expectedVersion: 1 }, activator); }
  catch (error) { activationDisabled = error instanceof ForbiddenException; }
  if (!activationDisabled) throw new Error('Programme activation bypassed disabled gate');
  let makerChecker = false;
  try { await programmes.activate(enrolment.id, { expectedVersion: 1 }, assigner); }
  catch (error) { makerChecker = error instanceof ForbiddenException; }
  if (!makerChecker) throw new Error('Programme assigner activated own assignment');
  await programmes.activate(enrolment.id, { expectedVersion: 1 }, activator);
  let evidenceMutationRejected = false;
  try { await dataSource.query("UPDATE student.programme_enrolments SET assignment_version='tampered' WHERE id=$1", [enrolment.id]); }
  catch { evidenceMutationRejected = true; }
  if (!evidenceMutationRejected) throw new Error('Programme assignment evidence was mutable');
  let programmeMutationRejected = false;
  try { await dataSource.query("UPDATE curriculum.programme_versions SET title='tampered' WHERE id=$1", [programme.id]); }
  catch { programmeMutationRejected = true; }
  if (!programmeMutationRejected) throw new Error('Published programme was mutable');
  const rows = await dataSource.query(`SELECT p.status programme_status,p.record_version,
    e.status enrolment_status,e.version enrolment_version,e.assignment_engine,e.assigned_by,e.activated_by,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='programme-version' AND resource_id=p.id::text) programme_audits,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='programme-enrolment' AND resource_id=e.id::text) enrolment_audits,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='programme-enrolment' AND aggregate_id=e.id::text) payload
    FROM curriculum.programme_versions p JOIN student.programme_enrolments e ON e.programme_version_id=p.id
    WHERE p.id=$1`, [programme.id]);
  const proof = rows[0];
  if (proof?.programme_status !== 'PUBLISHED' || proof?.record_version !== 2
    || proof?.enrolment_status !== 'ACTIVE' || proof?.enrolment_version !== 2
    || proof?.assignment_engine !== 'synthetic-mapper' || proof?.assigned_by === proof?.activated_by
    || proof?.programme_audits !== 2 || proof?.enrolment_audits !== 2
    || JSON.stringify(Object.keys(proof?.payload ?? {}).sort())
      !== '["programmeEnrolmentId","programmeVersionId","studentId"]') {
    throw new Error('Programme publication, assignment, activation, audit, or event evidence is incomplete');
  }
  process.stdout.write('Programme regulation linkage, publication/activation gates, effective overlap exclusion, maker-checker activation, immutable history, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
