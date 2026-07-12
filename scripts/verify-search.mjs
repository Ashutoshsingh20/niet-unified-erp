import { randomUUID } from 'node:crypto';
import { Client } from '@opensearch-project/opensearch';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { OpenSearchQueryAdapter } from '../apps/api/dist/platform/search/opensearch-query.adapter.js';
import { SearchService } from '../apps/api/dist/modules/search/search.service.js';
import { SearchProjectionService } from '../apps/worker/dist/search/search-projection.service.js';

const databaseUrl = process.env.DATABASE_URL;
const node = process.env.OPENSEARCH_NODE;
const username = process.env.OPENSEARCH_USERNAME;
const password = process.env.OPENSEARCH_PASSWORD;
const index = process.env.OPENSEARCH_INDEX ?? 'niet-erp-search-verification';
if (databaseUrl === undefined || node === undefined || username === undefined || password === undefined) {
  throw new Error('DATABASE_URL and OpenSearch connection variables are required');
}
const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();
const pool = new pg.Pool({ connectionString: databaseUrl, application_name: 'search-verifier' });
const client = new Client({ node, auth: { username, password } });

try {
  const database = await pool.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Search verification refuses to modify a database without a _test suffix');
  }
  if (process.env.OPENSEARCH_TEST_DISABLE_DISK_THRESHOLDS === 'true') {
    await client.cluster.putSettings({ body: {
      persistent: { 'cluster.blocks.create_index': false },
      transient: { 'cluster.routing.allocation.disk.threshold_enabled': false },
    } });
  }
  await client.indices.delete({ index, ignore_unavailable: true });
  const configValues = { OPENSEARCH_NODE: node, OPENSEARCH_USERNAME: username,
    OPENSEARCH_PASSWORD: password, OPENSEARCH_INDEX: index };
  const adapter = new OpenSearchQueryAdapter({ get(key) { return configValues[key]; } });
  const service = new SearchService(dataSource, new PolicyService(),
    new TransactionalEvidenceService(new RequestContextService()), adapter);
  const scopeId = randomUUID();
  const sourceId = `student-${randomUUID()}`;
  const indexer = { subjectId: 'search-indexer', assuranceLevel: 2,
    permissions: new Set(['platform.search.index']), scopes: { institution: ['*'] } };
  const registered = await service.upsert({ sourceType: 'student-record', sourceId,
    sourceVersion: 1, title: 'Aarav Sharma', summary: 'B.Tech student academic profile',
    requiredPermission: 'student.read', scopeType: 'organization', scopeId,
    classification: 'CONFIDENTIAL', actionPath: `/students/${sourceId}` }, indexer);
  const projection = new SearchProjectionService(pool, client, index, 3);
  let indexed = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await projection.processOne()) break;
    const state = await pool.query(
      'SELECT projection_status FROM search.records WHERE id = $1', [registered.id]);
    if (state.rows[0]?.projection_status === 'INDEXED') {
      indexed = true;
      break;
    }
  }
  if (!indexed) throw new Error('Search projection did not index the registered record');
  await client.indices.refresh({ index });

  const allowed = { subjectId: 'authorized-searcher', assuranceLevel: 1,
    permissions: new Set(['student.read']), scopes: { organization: [scopeId] } };
  const deniedScope = { ...allowed, scopes: { organization: [randomUUID()] } };
  const deniedPermission = { ...allowed, permissions: new Set(['employee.read']) };
  const result = await service.query({ q: 'Aarav', limit: 20 }, allowed);
  if (result.items.length !== 1 || result.items[0]?.sourceId !== sourceId) {
    throw new Error('Authorized search result was not returned');
  }
  if ((await service.query({ q: 'Aarav', limit: 20 }, deniedScope)).items.length !== 0) {
    throw new Error('Search exposed a result outside the actor scope');
  }
  if ((await service.query({ q: 'Aarav', limit: 20 }, deniedPermission)).items.length !== 0) {
    throw new Error('Search exposed a result without the required permission');
  }

  await client.update({ index, id: registered.id, refresh: true,
    body: { doc: { requiredPermission: 'employee.read', scopeType: 'organization',
      scopeId: [...deniedScope.scopes.organization][0] } } });
  const tampered = await service.query({ q: 'Aarav', limit: 20 }, deniedPermission);
  if (tampered.items.length !== 0) {
    throw new Error('Tampered OpenSearch authorization fields bypassed PostgreSQL re-authorization');
  }
  process.stdout.write('OpenSearch projection, permission filtering, scope filtering, and source re-authorization verified\n');
} finally {
  await client.indices.delete({ index, ignore_unavailable: true }).catch(() => undefined);
  await dataSource.destroy();
  await pool.end();
}
