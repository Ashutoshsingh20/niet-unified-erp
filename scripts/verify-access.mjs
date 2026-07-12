import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AccessGrantService } from '../apps/api/dist/platform/auth/access-grant.service.js';
import { PolicyService } from '../apps/api/dist/platform/auth/policy.service.js';
import { TransactionalEvidenceService } from '../apps/api/dist/platform/evidence/transactional-evidence.service.js';
import { RequestContextService } from '../apps/api/dist/platform/request-context/request-context.service.js';
import { AccessService } from '../apps/api/dist/modules/access/access.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');

const dataSource = new DataSource({ type: 'postgres', url: databaseUrl });
await dataSource.initialize();

try {
  const database = await dataSource.query('SELECT current_database() AS name');
  if (!String(database[0]?.name ?? '').endsWith('_test')) {
    throw new Error('Access verification refuses to modify a database without a _test suffix');
  }

  const rootUnitId = randomUUID();
  const childUnitId = randomUUID();
  const roleId = randomUUID();
  const assignmentId = randomUUID();
  const delegationId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await dataSource.query(
    `INSERT INTO organization.units
      (id, unit_key, unit_type, name, status, effective_from, created_by)
     VALUES ($1, $2, 'verification', 'Verification root', 'ACTIVE', clock_timestamp(), 'verifier')`,
    [rootUnitId, `verification-root-${suffix}`],
  );
  await dataSource.query(
    `INSERT INTO organization.units
      (id, unit_key, unit_type, name, parent_id, status, effective_from, created_by)
     VALUES ($1, $2, 'verification', 'Verification child', $3, 'ACTIVE', clock_timestamp(), 'verifier')`,
    [childUnitId, `verification-child-${suffix}`, rootUnitId],
  );
  await dataSource.query(
    `INSERT INTO access.roles
      (id, role_key, title, status, version, created_by)
     VALUES ($1, $2, 'Verification role', 'ACTIVE', 1, 'verifier')`,
    [roleId, `verification-role-${suffix}`],
  );
  await dataSource.query(
    "INSERT INTO access.role_permissions(role_id, permission) VALUES ($1, 'verification.read')",
    [roleId],
  );
  await dataSource.query(
    `INSERT INTO access.subject_role_assignments
      (id, subject_id, role_id, scope_type, scope_id, effective_from, granted_by, reason)
     VALUES ($1, 'verification-subject', $2, 'organization', $3, clock_timestamp(),
             'verifier', 'Verify descendant scope expansion')`,
    [assignmentId, roleId, rootUnitId],
  );
  await dataSource.query(
    `INSERT INTO access.delegations
      (id, delegator_subject_id, delegate_subject_id, permission, scope_type, scope_id,
       effective_from, effective_until, reason, status, created_by, source_assignment_id)
     VALUES ($1, 'verification-subject', 'verification-delegate', 'verification.read',
             'organization', $2, clock_timestamp() - interval '1 minute',
             clock_timestamp() + interval '1 hour', 'Verify bounded delegation', 'ACTIVE', 'verifier', $3)`,
    [delegationId, childUnitId, assignmentId],
  );

  const grants = new AccessGrantService(dataSource);
  const principal = await grants.resolve({ subjectId: 'verification-subject', assuranceLevel: 2 });
  if (!principal.permissions.has('verification.read')) throw new Error('Direct role permission was not resolved');
  if (!(principal.scopes.organization ?? []).includes(childUnitId)) {
    throw new Error('Organization descendant scope was not expanded');
  }
  const delegate = await grants.resolve({ subjectId: 'verification-delegate', assuranceLevel: 2 });
  if (!delegate.permissions.has('verification.read')) throw new Error('Delegated permission was not resolved');
  if (!(delegate.scopes.organization ?? []).includes(childUnitId)) {
    throw new Error('Delegated scope was not resolved');
  }
  await dataSource.query(
    "UPDATE access.subject_role_assignments SET revoked_at = clock_timestamp(), revoked_by = 'verifier' WHERE id = $1",
    [assignmentId],
  );
  const revokedDelegate = await grants.resolve({ subjectId: 'verification-delegate', assuranceLevel: 2 });
  if (revokedDelegate.permissions.has('verification.read')) {
    throw new Error('Delegated permission survived source assignment revocation');
  }

  const reviewedAssignmentId = randomUUID();
  await dataSource.query(
    `INSERT INTO access.subject_role_assignments
      (id, subject_id, role_id, scope_type, scope_id, effective_from, granted_by, reason)
     VALUES ($1, 'reviewed-subject', $2, 'organization', $3, clock_timestamp(),
             'verifier', 'Verify access review revocation')`,
    [reviewedAssignmentId, roleId, childUnitId],
  );
  const principalForReview = {
    subjectId: 'verification-reviewer',
    assuranceLevel: 2,
    permissions: new Set(['platform.access.review']),
    scopes: { organization: [childUnitId] },
  };
  const evidence = new TransactionalEvidenceService(new RequestContextService());
  const access = new AccessService(dataSource, new PolicyService(), evidence);
  const review = await access.createAccessReview({
    title: 'Verification access review',
    scopeType: 'organization',
    scopeId: childUnitId,
    reviewerSubjectId: principalForReview.subjectId,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  }, principalForReview);
  if (review.itemCount !== 1) throw new Error('Access review did not snapshot the active assignment');
  const reviewItems = await dataSource.query(
    'SELECT id, assignment_version_at_review FROM access.review_items WHERE review_id = $1',
    [review.id],
  );
  await access.decideAccessReviewItem(review.id, reviewItems[0].id, {
    decision: 'REVOKE',
    reason: 'Verification revocation decision',
    expectedAssignmentVersion: reviewItems[0].assignment_version_at_review,
  }, principalForReview);
  const reviewState = await dataSource.query(
    `SELECT r.status, a.revoked_at
     FROM access.reviews r
     JOIN access.review_items i ON i.review_id = r.id
     JOIN access.subject_role_assignments a ON a.id = i.assignment_id
     WHERE r.id = $1`,
    [review.id],
  );
  if (reviewState[0]?.status !== 'COMPLETED' || reviewState[0]?.revoked_at === null) {
    throw new Error('Access review did not complete and revoke its assignment atomically');
  }
  process.stdout.write('Role, descendant-scope, and delegation resolution verified\n');
  process.stdout.write('Access review snapshot and revocation verified\n');
} finally {
  await dataSource.destroy();
}
