import { DataSource } from 'typeorm';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { DocumentsService, validateFilename } from '../apps/api/dist/modules/documents/documents.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');

class VerificationObjectStorage {
  metadata;
  promoted = false;

  async createQuarantineUpload(input) {
    this.metadata = { sizeBytes: 128, contentType: input.contentType, sha256: input.sha256 };
    return { url: 'http://storage.invalid/quarantine',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      requiredHeaders: { 'content-type': input.contentType } };
  }

  async headQuarantineObject() {
    if (this.metadata === undefined) throw new Error('No verification object');
    return this.metadata;
  }

  async promoteToClean() {
    this.promoted = true;
  }

  async createCleanDownload() {
    if (!this.promoted) throw new Error('Object was not promoted');
    return 'http://storage.invalid/clean-download';
  }
}

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();

try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Document verification refuses to modify a database without a _test suffix');
  }
  let unsafeFilenameRejected = false;
  try {
    validateFilename('../identity.pdf');
  } catch {
    unsafeFilenameRejected = true;
  }
  if (!unsafeFilenameRejected) throw new Error('Unsafe filename was not rejected');

  const storage = new VerificationObjectStorage();
  const service = new DocumentsService(dataSource, new PolicyService(),
    new TransactionalEvidenceService(new RequestContextService()), storage);
  const principal = { subjectId: 'document-verifier', assuranceLevel: 2,
    permissions: new Set(['platform.documents.configure', 'platform.documents.upload',
      'platform.documents.read']), scopes: { institution: ['*'] } };
  const scanner = { subjectId: 'document-scanner', assuranceLevel: 2,
    permissions: new Set(['platform.documents.scan']), scopes: { institution: ['*'] } };
  const suffix = crypto.randomUUID().slice(0, 8);
  const type = await service.createType({ typeKey: `verification.identity-${suffix}`, version: 1,
    title: 'Verification identity document', allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 1024, classification: 'RESTRICTED', retentionDays: 30 }, principal);
  await service.publishType(type.id, principal);
  const sha256 = 'a'.repeat(64);
  const initiated = await service.initiateUpload({ documentTypeKey: `verification.identity-${suffix}`,
    filename: 'identity.pdf', mimeType: 'application/pdf', sizeBytes: 128, sha256,
    scopeType: 'institution', scopeId: '*' }, principal);
  await service.completeUpload(initiated.documentId, principal);

  let mismatchedScanRejected = false;
  try {
    await service.recordScan(initiated.documentId, { outcome: 'CLEAN', scannerEngine: 'verification-av',
      signatureVersion: '1', detectedMimeType: 'application/pdf', computedSha256: 'b'.repeat(64),
      reason: 'Verification clean result with wrong hash' }, scanner);
  } catch {
    mismatchedScanRejected = true;
  }
  if (!mismatchedScanRejected) throw new Error('Clean scan with mismatched byte hash was accepted');

  await service.recordScan(initiated.documentId, { outcome: 'CLEAN', scannerEngine: 'verification-av',
    signatureVersion: '1', detectedMimeType: 'application/pdf', computedSha256: sha256,
    reason: 'Verification file is clean' }, scanner);
  await service.promote(initiated.documentId, scanner);
  const download = await service.createDownload(initiated.documentId, principal);
  if (download.url !== 'http://storage.invalid/clean-download') {
    throw new Error('Clean document download grant was not created');
  }
  const state = await dataSource.query(
    `SELECT status, computed_sha256, scanner_engine,
            (SELECT count(*)::int FROM platform.audit_events a
             WHERE a.resource_type = 'document' AND a.resource_id = r.id::text) AS audit_count,
            (SELECT count(*)::int FROM platform.outbox_events o
             WHERE o.aggregate_type = 'document' AND o.aggregate_id = r.id::text) AS outbox_count
     FROM documents.records r WHERE id = $1`, [initiated.documentId]);
  if (state[0]?.status !== 'CLEAN' || state[0]?.computed_sha256 !== sha256
    || state[0]?.audit_count < 3 || state[0]?.outbox_count < 3) {
    throw new Error('Document state or evidence is incomplete');
  }
  process.stdout.write('Document quarantine, byte-integrity scan, promotion, and download verified\n');
} finally {
  await dataSource.destroy();
}
