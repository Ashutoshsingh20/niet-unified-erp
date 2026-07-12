import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdmissionsService } from '../apps/api/dist/modules/admissions/admissions.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Admissions verification requires _test');
  const suffix = randomUUID().slice(0, 8); const scopeId = randomUUID();
  const policy = new PolicyService(); const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = new AdmissionsService(dataSource, policy, evidence, { get: () => true });
  const disabled = new AdmissionsService(dataSource, policy, evidence, { get: () => false });
  const applicant = { subjectId: `applicant-${suffix}`, assuranceLevel: 2, permissions: new Set(), scopes: { organization: [scopeId] } };
  const reviewer = { ...applicant, subjectId: `reviewer-${suffix}` };
  const input = { applicantSubjectId: applicant.subjectId, programmeKey: `PROGRAMME-${suffix}`,
    encryptedPayloadBase64: randomBytes(64).toString('base64'), encryptionKeyReference: 'synthetic-key-v1',
    payloadSha256: 'a'.repeat(64), idempotencyKey: randomUUID(), scopeType: 'organization', scopeId };
  const created = await enabled.create(input, applicant); const replay = await enabled.create(input, applicant);
  if (!replay.replayed || replay.id !== created.id) throw new Error('Admission draft retry was not idempotent');
  let changedRejected = false;
  try { await enabled.create({ ...input, payloadSha256: 'b'.repeat(64) }, applicant); }
  catch (error) { changedRejected = error instanceof ConflictException; }
  if (!changedRejected) throw new Error('Changed admission retry was accepted');
  let submitOwnership = false;
  try { await enabled.submit(created.id, { expectedVersion: 1, evidenceManifestSha256: 'c'.repeat(64) }, reviewer); }
  catch (error) { submitOwnership = error instanceof ForbiddenException; }
  if (!submitOwnership) throw new Error('Non-applicant submitted application');
  await enabled.submit(created.id, { expectedVersion: 1, evidenceManifestSha256: 'c'.repeat(64) }, applicant);
  const decision = { outcome: 'OFFERED', evaluationEngine: 'synthetic-evaluator', evaluationVersion: 'v1',
    regulationReference: 'SYNTHETIC-VERIFICATION-ONLY', evaluationTrace: { result: 'SYNTHETIC_ELIGIBLE' },
    reason: 'Synthetic evaluator offer', expectedVersion: 2 };
  let disabledGate = false;
  try { await disabled.decide(created.id, decision, reviewer); }
  catch (error) { disabledGate = error instanceof ForbiddenException; }
  if (!disabledGate) throw new Error('Admission decision bypassed disabled gate');
  await enabled.decide(created.id, decision, reviewer);
  let mutationRejected = false;
  try { await dataSource.query("UPDATE admissions.decisions SET reason='tampered' WHERE application_id=$1", [created.id]); }
  catch { mutationRejected = true; }
  if (!mutationRejected) throw new Error('Admission decision evidence was mutable');
  const rows = await dataSource.query(`SELECT a.status,a.version,d.evaluation_engine,d.regulation_reference,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='admission-application' AND resource_id=a.id::text) audits,
    (SELECT bool_and(payload - ARRAY['admissionApplicationId']='{}'::jsonb) FROM platform.outbox_events
      WHERE aggregate_type='admission-application' AND aggregate_id=a.id::text) minimum_payload
    FROM admissions.applications a JOIN admissions.decisions d ON d.application_id=a.id WHERE a.id=$1`, [created.id]);
  const proof = rows[0];
  if (proof?.status !== 'OFFERED' || proof?.version !== 3 || proof?.evaluation_engine !== 'synthetic-evaluator'
    || proof?.regulation_reference !== 'SYNTHETIC-VERIFICATION-ONLY' || proof?.audits !== 3 || proof?.minimum_payload !== true) {
    throw new Error('Admission decision, audit, or minimum-data evidence is incomplete');
  }
  process.stdout.write('Admissions encryption boundary, scope, applicant submission, idempotency, disabled decision gate, evaluator evidence, immutable history, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
