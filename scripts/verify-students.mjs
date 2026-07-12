import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Student verification requires a _test database');
  }
  const service = new StudentsService(dataSource, new PolicyService(),
    new TransactionalEvidenceService(new RequestContextService()));
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const creator = { subjectId: `student-record-creator-${suffix}`, assuranceLevel: 2,
    permissions: new Set(['student.record.create', 'student.record.read']),
    scopes: { organization: [scopeId] } };
  const input = { idempotencyKey: randomUUID(), subjectId: `synthetic-student-${suffix}`,
    displayName: 'Synthetic Student', scopeType: 'organization', scopeId,
    sourceSystem: 'synthetic-admissions', sourceKey: `application-${suffix}`,
    sourceExtractedAt: new Date().toISOString(), mappingVersion: 'synthetic-v1',
    sourceRowSha256: 'd'.repeat(64) };
  const created = await service.create(input, creator);
  if (created.replayed) throw new Error('First student creation was marked as a replay');
  const replay = await service.create(input, creator);
  if (!replay.replayed || replay.id !== created.id) throw new Error('Exact retry was not idempotent');

  let changedReplayRejected = false;
  try {
    await service.create({ ...input, displayName: 'Changed Synthetic Student' }, creator);
  } catch (error) {
    changedReplayRejected = error instanceof ConflictException;
  }
  if (!changedReplayRejected) throw new Error('Changed idempotent replay was accepted');

  const record = await service.get(created.id, creator);
  if (record.status !== 'PROVISIONAL' || record.displayName !== input.displayName
    || record.sourceSystem !== input.sourceSystem || record.mappingVersion !== input.mappingVersion) {
    throw new Error('Canonical provisional student record did not preserve source metadata');
  }
  let wrongScopeDenied = false;
  try {
    await service.get(created.id, { ...creator, scopes: { organization: [randomUUID()] } });
  } catch (error) {
    wrongScopeDenied = error instanceof ForbiddenException;
  }
  if (!wrongScopeDenied) throw new Error('Student record was disclosed outside its scope');

  let provenanceRejected = false;
  try {
    await dataSource.query('UPDATE student.records SET source_key = $2 WHERE id = $1',
      [created.id, 'tampered-source']);
  } catch {
    provenanceRejected = true;
  }
  if (!provenanceRejected) throw new Error('Student source provenance was mutable');
  let historyRejected = false;
  try {
    await dataSource.query('DELETE FROM student.status_history WHERE student_id = $1', [created.id]);
  } catch {
    historyRejected = true;
  }
  if (!historyRejected) throw new Error('Student status history was mutable');

  const evidence = await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM platform.audit_events
        WHERE resource_type = 'student-record' AND resource_id = $1) AS audits,
       (SELECT payload FROM platform.outbox_events
        WHERE aggregate_type = 'student-record' AND aggregate_id = $1
        ORDER BY occurred_at DESC LIMIT 1) AS payload,
       (SELECT count(*)::int FROM student.status_history WHERE student_id = $1::uuid) AS history`,
    [created.id]);
  const proof = evidence[0];
  const payloadKeys = Object.keys(proof?.payload ?? {}).sort();
  if (proof?.audits !== 1 || proof?.history !== 1
    || JSON.stringify(payloadKeys) !== JSON.stringify(['scopeId', 'scopeType', 'studentId'])) {
    throw new Error('Student audit, history, or minimum-data outbox evidence is invalid');
  }
  process.stdout.write('Canonical student idempotency, provenance, scope, history, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}
