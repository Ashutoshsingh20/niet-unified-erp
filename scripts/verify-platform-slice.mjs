import { randomUUID } from 'node:crypto';
import { Client } from '@opensearch-project/opensearch';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { OpenSearchQueryAdapter } from '../apps/api/dist/platform/search/opensearch-query.adapter.js';
import { DocumentsService } from '../apps/api/dist/modules/documents/documents.service.js';
import { NotificationsService } from '../apps/api/dist/modules/notifications/notifications.service.js';
import { SearchService } from '../apps/api/dist/modules/search/search.service.js';
import { WorkflowService } from '../apps/api/dist/modules/workflow/workflow.service.js';
import { SearchProjectionService } from '../apps/worker/dist/search/search-projection.service.js';

const databaseUrl = process.env.DATABASE_URL;
const node = process.env.OPENSEARCH_NODE;
const username = process.env.OPENSEARCH_USERNAME;
const password = process.env.OPENSEARCH_PASSWORD;
const index = process.env.OPENSEARCH_INDEX ?? 'niet-erp-platform-slice-verification';
if ([databaseUrl, node, username, password].some((value) => value === undefined)) {
  throw new Error('DATABASE_URL and OpenSearch connection variables are required');
}

class SliceStorage {
  metadata;
  promoted = false;
  async createQuarantineUpload(input) {
    this.metadata = { sizeBytes: 256, contentType: input.contentType, sha256: input.sha256 };
    return { url: 'http://storage.invalid/quarantine', expiresAt: new Date(Date.now() + 300_000).toISOString(),
      requiredHeaders: { 'content-type': input.contentType } };
  }
  async headQuarantineObject() { return this.metadata; }
  async promoteToClean() { this.promoted = true; }
  async createCleanDownload() {
    if (!this.promoted) throw new Error('Slice document was not promoted');
    return 'http://storage.invalid/clean';
  }
}

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
const pool = new pg.Pool({ connectionString: databaseUrl, application_name: 'platform-slice-verifier' });
const client = new Client({ node, auth: { username, password } });

try {
  const database = await pool.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Platform slice verification requires a _test database');
  }
  if (process.env.OPENSEARCH_TEST_DISABLE_DISK_THRESHOLDS === 'true') {
    await client.cluster.putSettings({ body: { persistent: { 'cluster.blocks.create_index': false },
      transient: { 'cluster.routing.allocation.disk.threshold_enabled': false } } });
  }
  await client.indices.delete({ index, ignore_unavailable: true });
  const suffix = randomUUID().slice(0, 8);
  const correlationId = randomUUID();
  const scopeId = randomUUID();
  const context = new RequestContextService();
  const policy = new PolicyService();
  const evidence = new TransactionalEvidenceService(context);
  const storage = new SliceStorage();
  const documents = new DocumentsService(dataSource, policy, evidence, storage);
  const workflows = new WorkflowService(dataSource, policy, evidence);
  const notifications = new NotificationsService(dataSource, policy, evidence);
  const adapter = new OpenSearchQueryAdapter({ get(key) { return {
    OPENSEARCH_NODE: node, OPENSEARCH_USERNAME: username, OPENSEARCH_PASSWORD: password,
    OPENSEARCH_INDEX: index,
  }[key]; } });
  const search = new SearchService(dataSource, policy, evidence, adapter);

  const requester = { subjectId: `slice-requester-${suffix}`, assuranceLevel: 2,
    permissions: new Set(['slice.request.submit', 'slice.case.read', 'platform.notifications.read']),
    scopes: { organization: [scopeId] } };
  const approver = { subjectId: `slice-approver-${suffix}`, assuranceLevel: 2,
    permissions: new Set(['slice.request.approve']), scopes: { organization: [scopeId] } };
  const scanner = { subjectId: `slice-scanner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(['platform.documents.scan']), scopes: { organization: [scopeId] } };
  const administrator = { subjectId: `slice-admin-${suffix}`, assuranceLevel: 3,
    permissions: new Set(['platform.documents.configure', 'platform.notifications.configure',
      'platform.notifications.send', 'platform.search.index']), scopes: { institution: ['*'] } };

  await context.run({ correlationId }, async () => {
    const documentTypeKey = `slice.evidence-${suffix}`;
    const documentType = await documents.createType({ typeKey: documentTypeKey, version: 1,
      title: 'Platform slice evidence', allowedMimeTypes: ['application/pdf'], maxSizeBytes: 1024,
      classification: 'CONFIDENTIAL', retentionDays: 30 }, administrator);
    await documents.publishType(documentType.id, administrator);
    const sha256 = 'c'.repeat(64);
    const uploaded = await documents.initiateUpload({ documentTypeKey, filename: 'evidence.pdf',
      mimeType: 'application/pdf', sizeBytes: 256, sha256, scopeType: 'organization', scopeId }, requester);
    await documents.completeUpload(uploaded.documentId, requester);
    await documents.recordScan(uploaded.documentId, { outcome: 'CLEAN', scannerEngine: 'slice-av',
      signatureVersion: '1', detectedMimeType: 'application/pdf', computedSha256: sha256,
      reason: 'Synthetic verification file is clean' }, scanner);
    await documents.promote(uploaded.documentId, scanner);

    const definitionKey = `slice.request-${suffix}`;
    const definition = await workflows.createDefinition({ definitionKey, version: 1,
      title: 'Document-backed platform request', description: 'Phase 1 correlated verification',
      submitPermission: 'slice.request.submit', approvalPermission: 'slice.request.approve',
      prohibitRequesterApproval: true }, administrator);
    await workflows.publishDefinition(definition.id, administrator);
    const submitted = await workflows.submit({ definitionKey, title: 'Verify platform slice',
      requestData: { documentId: uploaded.documentId }, scopeType: 'organization', scopeId }, requester);
    await workflows.decide(submitted.taskId, { decision: 'APPROVED',
      reason: 'Independent correlated slice approval', expectedVersion: 1 }, approver);

    const templateKey = `slice.approved-${suffix}`;
    const template = await notifications.createTemplate({ templateKey, version: 1,
      titleTemplate: '{{caseName}} approved', bodyTemplate: 'Your {{caseName}} request was approved.',
      requiredVariables: ['caseName'], allowExternalPush: false }, administrator);
    await notifications.publishTemplate(template.id, administrator);
    await notifications.create({ templateKey, recipientSubjectId: requester.subjectId,
      scopeType: 'organization', scopeId, variables: { caseName: 'platform verification' },
      classification: 'CONFIDENTIAL', actionPath: `/workflows/${submitted.id}`, expiresInDays: 7 }, administrator);

    await search.upsert({ sourceType: 'workflow-instance', sourceId: submitted.id, sourceVersion: 2,
      title: 'Verify platform slice', summary: 'Approved document-backed request',
      requiredPermission: 'slice.case.read', scopeType: 'organization', scopeId,
      classification: 'CONFIDENTIAL', actionPath: `/workflows/${submitted.id}` }, administrator);
  });

  const projection = new SearchProjectionService(pool, client, index, 3);
  for (let attempt = 0; attempt < 50 && await projection.processOne(); attempt += 1) {}
  await client.indices.refresh({ index });
  const results = await search.query({ q: 'platform slice', limit: 10 }, requester);
  if (!results.items.some((item) => item.title === 'Verify platform slice')) {
    throw new Error('Authorized requester could not find the correlated case');
  }
  const forbidden = { ...requester, subjectId: `slice-forbidden-${suffix}`,
    permissions: new Set(), scopes: { organization: [scopeId] } };
  if ((await search.query({ q: 'platform slice', limit: 10 }, forbidden)).items.length !== 0) {
    throw new Error('Forbidden actor found the correlated case');
  }
  const inbox = await notifications.list(requester, { limit: 10 });
  if (!inbox.items.some((item) => item.title === 'platform verification approved')) {
    throw new Error('Requester did not receive the correlated approval notification');
  }
  const evidenceRows = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM platform.audit_events WHERE correlation_id = $1) AS audits,
       (SELECT count(*)::int FROM platform.outbox_events WHERE correlation_id = $1) AS outbox,
       (SELECT status FROM workflow.instances WHERE requester_subject_id = $2 ORDER BY submitted_at DESC LIMIT 1) AS status,
       (SELECT status FROM documents.records WHERE owner_subject_id = $2 ORDER BY created_at DESC LIMIT 1) AS document_status`,
    [correlationId, requester.subjectId]);
  const proof = evidenceRows.rows[0];
  if (proof?.status !== 'APPROVED' || proof?.document_status !== 'CLEAN'
    || proof?.audits < 10 || proof?.outbox < 6) {
    throw new Error('Correlated transactional evidence is incomplete');
  }
  process.stdout.write('Correlated document, approval, notification, search authorization, audit, and outbox slice verified\n');
} finally {
  await client.indices.delete({ index, ignore_unavailable: true }).catch(() => undefined);
  await dataSource.destroy();
  await pool.end();
}
