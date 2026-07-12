import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MigrationService } from '../apps/api/dist/modules/migration/migration.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) throw new Error('Migration verification requires _test');
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const enabled = new MigrationService(dataSource, policy, evidence, { get: () => true });
  const disabled = new MigrationService(dataSource, policy, evidence, { get: () => false });
  const reconciler = { subjectId: `migration-reconciler-${suffix}`, assuranceLevel: 2,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  const approver = { ...reconciler, subjectId: `migration-approver-${suffix}` };
  const outsider = { ...reconciler, scopes: { organization: [randomUUID()] } };
  const batch = await enabled.create({ batchKey: `synthetic-${suffix}`, sourceSystem: 'synthetic-legacy',
    sourceManifestSha256: 'a'.repeat(64), mappingVersion: 'synthetic-v1',
    scopeType: 'organization', scopeId }, reconciler);
  let scopeDenied = false;
  try { await enabled.stage(batch.id, { sourceKey: 'outside', sourceRowSha256: '1'.repeat(64),
    extractedAt: new Date().toISOString(), encryptedCandidateBase64: randomBytes(32).toString('base64'),
    encryptionKeyReference: 'synthetic-key-v1' }, outsider); }
  catch (error) { scopeDenied = error instanceof ForbiddenException; }
  if (!scopeDenied) throw new Error('Migration staging ignored tenant scope');
  const rows = [
    { sourceKey: 'legacy-001', sourceRowSha256: '1'.repeat(64) },
    { sourceKey: 'legacy-002', sourceRowSha256: '2'.repeat(64) },
  ];
  for (const row of rows) await enabled.stage(batch.id, { ...row, extractedAt: new Date().toISOString(),
    encryptedCandidateBase64: randomBytes(48).toString('base64'),
    encryptionKeyReference: 'synthetic-key-v1' }, reconciler);
  let duplicateRejected = false;
  try { await enabled.stage(batch.id, { ...rows[0], sourceRowSha256: '3'.repeat(64),
    extractedAt: new Date().toISOString(), encryptedCandidateBase64: randomBytes(48).toString('base64'),
    encryptionKeyReference: 'synthetic-key-v1' }, reconciler); }
  catch (error) { duplicateRejected = error instanceof ConflictException; }
  if (!duplicateRejected) throw new Error('Duplicate migration source key was accepted');
  await enabled.validate(batch.id, { expectedVersion: 2 }, reconciler);
  const expectedHash = createHash('sha256').update(rows.map((row) =>
    `${row.sourceKey}:${row.sourceRowSha256}`).join('\n')).digest('hex');
  let mismatchRejected = false;
  try { await enabled.reconcile(batch.id, { expectedVersion: 3, expectedRowCount: '2',
    expectedRowsSha256: 'f'.repeat(64) }, reconciler); }
  catch (error) { mismatchRejected = error instanceof ConflictException; }
  if (!mismatchRejected) throw new Error('Mismatched migration control totals were accepted');
  await enabled.reconcile(batch.id, { expectedVersion: 3, expectedRowCount: '2',
    expectedRowsSha256: expectedHash }, reconciler);
  let makerCheckerEnforced = false;
  try { await enabled.approve(batch.id, { expectedVersion: 4,
    reconciliationReference: `SYNTHETIC-${suffix}` }, reconciler); }
  catch (error) { makerCheckerEnforced = error instanceof ForbiddenException; }
  if (!makerCheckerEnforced) throw new Error('Migration reconciler approved their own batch');
  await enabled.approve(batch.id, { expectedVersion: 4,
    reconciliationReference: `SYNTHETIC-${suffix}` }, approver);
  let applicationDisabled = false;
  try { await disabled.apply(batch.id, { expectedVersion: 5 }, approver); }
  catch (error) { applicationDisabled = error instanceof ForbiddenException; }
  if (!applicationDisabled) throw new Error('Migration application bypassed its disabled gate');
  let missingAdapterRejected = false;
  try { await enabled.apply(batch.id, { expectedVersion: 5 }, approver); }
  catch (error) { missingAdapterRejected = error instanceof ConflictException; }
  if (!missingAdapterRejected) throw new Error('Migration claimed application without an approved adapter');
  let evidenceMutationRejected = false;
  try { await dataSource.query("DELETE FROM migration.staged_rows WHERE batch_id=$1", [batch.id]); }
  catch { evidenceMutationRejected = true; }
  if (!evidenceMutationRejected) throw new Error('Migration staged evidence was mutable');
  const proofRows = await dataSource.query(`SELECT b.status,b.version,c.expected_row_count::text row_count,
    c.expected_rows_sha256,a.requested_by,a.approved_by,
    (SELECT count(*)::int FROM platform.audit_events WHERE resource_type='migration-batch'
      AND resource_id=b.id::text) audits,
    (SELECT payload FROM platform.outbox_events WHERE aggregate_type='migration-batch'
      AND aggregate_id=b.id::text AND event_type='MigrationBatchApproved') payload
    FROM migration.batches b JOIN migration.control_totals c ON c.batch_id=b.id
    JOIN migration.approvals a ON a.batch_id=b.id WHERE b.id=$1`, [batch.id]);
  const proof = proofRows[0];
  if (proof?.status !== 'APPROVED' || proof?.version !== 5 || proof?.row_count !== '2'
    || proof?.expected_rows_sha256 !== expectedHash || proof?.requested_by === proof?.approved_by
    || proof?.audits !== 4 || JSON.stringify(Object.keys(proof?.payload ?? {})) !== '["migrationBatchId"]') {
    throw new Error('Migration reconciliation, approval, audit, or minimum-data evidence is incomplete');
  }
  process.stdout.write('Migration scope, encrypted staging, duplicate rejection, control totals, maker-checker approval, fail-closed application, immutable evidence, audit, and outbox verified\n');
} finally { await dataSource.destroy(); }
