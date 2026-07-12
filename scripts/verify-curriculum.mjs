import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurriculumService } from '../apps/api/dist/modules/curriculum/curriculum.service.js';
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
    throw new Error('Curriculum verification requires a _test database');
  }
  const suffix = randomUUID().slice(0, 8);
  const scopeId = randomUUID();
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const disabled = new CurriculumService(dataSource, new PolicyService(), evidence,
    { get: () => false });
  const enabled = new CurriculumService(dataSource, new PolicyService(), evidence,
    { get: () => true });
  const actor = { subjectId: `curriculum-owner-${suffix}`, assuranceLevel: 2,
    permissions: new Set(['curriculum.regulation.draft', 'curriculum.regulation.publish',
      'curriculum.regulation.read']), scopes: { organization: [scopeId] } };
  const input = { regulationKey: `synthetic.regulation-${suffix}`, version: 1,
    title: 'Synthetic regulation preview', scopeType: 'organization', scopeId,
    ruleSchemaVersion: 'synthetic-schema-v1',
    ruleDocument: { kind: 'UNINTERPRETED_SYNTHETIC_PREVIEW', rules: [] },
    impactSummary: 'Synthetic empty rule set used only to verify publication controls.' };
  const draft = await enabled.create(input, actor);
  let duplicateRejected = false;
  try { await enabled.create(input, actor); } catch (error) {
    duplicateRejected = error instanceof ConflictException;
  }
  if (!duplicateRejected) throw new Error('Duplicate regulation version was accepted');
  let disabledRejected = false;
  try {
    await disabled.publish(draft.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, actor);
  } catch (error) {
    disabledRejected = error instanceof ForbiddenException;
  }
  if (!disabledRejected) throw new Error('Policy publication bypassed the disabled gate');
  let wrongScopeRejected = false;
  try {
    await enabled.publish(draft.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' },
    { ...actor, scopes: { organization: [randomUUID()] } });
  } catch (error) {
    wrongScopeRejected = error instanceof ForbiddenException;
  }
  if (!wrongScopeRejected) throw new Error('Regulation was published outside actor scope');
  await enabled.publish(draft.id, { expectedRecordVersion: 1,
    policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, actor);
  let staleRejected = false;
  try {
    await enabled.publish(draft.id, { expectedRecordVersion: 1,
      policyDecisionReference: 'SYNTHETIC-VERIFICATION-ONLY' }, actor);
  } catch (error) {
    staleRejected = error instanceof ConflictException;
  }
  if (!staleRejected) throw new Error('Published regulation accepted a stale publication');
  let mutationRejected = false;
  try {
    await dataSource.query(
      "UPDATE curriculum.regulation_versions SET rule_document = '{\"rules\":[\"tampered\"]}' WHERE id = $1",
      [draft.id]);
  } catch {
    mutationRejected = true;
  }
  if (!mutationRejected) throw new Error('Published regulation content was mutable');
  const regulation = await enabled.get(draft.id, actor);
  if (regulation.status !== 'PUBLISHED' || regulation.recordVersion !== 2
    || regulation.policyDecisionReference !== 'SYNTHETIC-VERIFICATION-ONLY') {
    throw new Error('Published regulation state is invalid');
  }
  const proofRows = await dataSource.query(
    `SELECT
       (SELECT count(*)::int FROM platform.audit_events
        WHERE resource_type = 'curriculum-regulation' AND resource_id = $1) AS audits,
       (SELECT payload FROM platform.outbox_events
        WHERE aggregate_type = 'curriculum-regulation' AND aggregate_id = $1 LIMIT 1) AS payload`,
    [draft.id]);
  const proof = proofRows[0];
  if (proof?.audits !== 2 || JSON.stringify(Object.keys(proof?.payload ?? {}).sort())
    !== JSON.stringify(['regulationId', 'regulationKey', 'version'])) {
    throw new Error('Curriculum audit or minimum-data publication event is invalid');
  }
  process.stdout.write('Curriculum draft, disabled gate, scope, publication, immutability, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}
