import { DataSource } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { WorkflowService } from '../apps/api/dist/modules/workflow/workflow.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();

try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Workflow verification refuses to modify a database without a _test suffix');
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const definitionKey = `verification.request-${suffix}`;
  const requester = {
    subjectId: 'workflow-requester', assuranceLevel: 2,
    permissions: new Set(['verification.request.submit', 'verification.request.approve']),
    scopes: { institution: ['*'] },
  };
  const approver = {
    subjectId: 'workflow-approver', assuranceLevel: 2,
    permissions: new Set(['verification.request.approve']),
    scopes: { institution: ['*'] },
  };
  const workflow = new WorkflowService(
    dataSource,
    new PolicyService(),
    new TransactionalEvidenceService(new RequestContextService()),
  );
  const definition = await workflow.createDefinition({
    definitionKey,
    version: 1,
    title: 'Verification request',
    description: 'Integration verification only',
    submitPermission: 'verification.request.submit',
    approvalPermission: 'verification.request.approve',
    prohibitRequesterApproval: true,
  }, approver);
  await workflow.publishDefinition(definition.id, approver);
  const request = await workflow.submit({
    definitionKey,
    title: 'Verify transactional approval',
    requestData: { verification: true },
  }, requester);

  let makerCheckerDenied = false;
  try {
    await workflow.decide(request.taskId, {
      decision: 'APPROVED', reason: 'Requester must not self-approve', expectedVersion: 1,
    }, requester);
  } catch (error) {
    makerCheckerDenied = error instanceof ForbiddenException;
  }
  if (!makerCheckerDenied) throw new Error('Maker/checker self-approval was not denied');

  await workflow.decide(request.taskId, {
    decision: 'APPROVED', reason: 'Independent verification approval', expectedVersion: 1,
  }, approver);
  const state = await dataSource.query(
    `SELECT i.status, i.version, t.status AS task_status,
            (SELECT count(*)::int FROM platform.audit_events a
             WHERE a.resource_type = 'workflow-instance' AND a.resource_id = i.id::text) AS audit_count,
            (SELECT count(*)::int FROM platform.outbox_events o
             WHERE o.aggregate_type = 'workflow-instance' AND o.aggregate_id = i.id::text) AS outbox_count
     FROM workflow.instances i JOIN workflow.tasks t ON t.instance_id = i.id
     WHERE i.id = $1`,
    [request.id],
  );
  const result = state[0];
  if (result?.status !== 'APPROVED' || result?.task_status !== 'APPROVED' || result?.version !== 2) {
    throw new Error('Workflow request and task did not reach the approved state');
  }
  if (result.audit_count < 2 || result.outbox_count < 2) {
    throw new Error('Workflow audit or outbox evidence is incomplete');
  }
  process.stdout.write('Workflow publication, maker/checker, approval, audit, and outbox verified\n');
} finally {
  await dataSource.destroy();
}

