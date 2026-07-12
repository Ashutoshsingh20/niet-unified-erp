import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const subjectId = process.env.BOOTSTRAP_SUBJECT_ID;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
if (subjectId === undefined || subjectId.length === 0) throw new Error('BOOTSTRAP_SUBJECT_ID is required');

const permissions = [
  'platform.access.assign',
  'platform.access.configure',
  'platform.access.delegate',
  'platform.access.review',
  'platform.access.review.override',
  'platform.organization.manage',
  'platform.workflow.configure',
  'platform.workflow.decide',
  'platform.workflow.publish',
  'platform.workflow.submit',
];
const client = new pg.Client({ connectionString: databaseUrl, application_name: 'niet-erp-access-bootstrap' });
await client.connect();

try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [2_024_071_201]);
  const state = await client.query(`
    SELECT
      (SELECT count(*)::int FROM access.roles) AS role_count,
      EXISTS (
        SELECT 1 FROM access.subject_role_assignments a
        JOIN access.roles r ON r.id = a.role_id
        WHERE a.subject_id = $1 AND r.role_key = 'platform-security-bootstrap'
          AND a.revoked_at IS NULL
      ) AS already_bootstrapped
  `, [subjectId]);
  if (state.rows[0]?.already_bootstrapped === true) {
    await client.query('ROLLBACK');
    process.stdout.write('Access governance is already bootstrapped for this subject\n');
    process.exit(0);
  }
  if (state.rows[0]?.role_count !== 0) {
    throw new Error('Access data already exists; bootstrap refused to avoid privilege escalation');
  }

  const roleId = randomUUID();
  const assignmentId = randomUUID();
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO access.roles
      (id, role_key, title, description, status, version, created_by)
     VALUES ($1, 'platform-security-bootstrap', 'Platform security bootstrap',
             'One-time technical role used to establish institution-approved access governance',
             'ACTIVE', 1, $2)`,
    [roleId, subjectId],
  );
  for (const permission of permissions) {
    await client.query(
      'INSERT INTO access.role_permissions(role_id, permission) VALUES ($1, $2)',
      [roleId, permission],
    );
  }
  await client.query(
    `INSERT INTO access.subject_role_assignments
      (id, subject_id, role_id, scope_type, scope_id, effective_from, granted_by, reason)
     VALUES ($1, $2, $3, 'institution', '*', clock_timestamp(), $2,
             'Initial controlled access-governance bootstrap')`,
    [assignmentId, subjectId, roleId],
  );
  await client.query(
    `INSERT INTO platform.audit_events
      (id, actor_subject_id, action, resource_type, resource_id, outcome, correlation_id, details)
     VALUES ($1, $2, 'access.bootstrap.completed', 'access-assignment', $3, 'SUCCEEDED',
             'access-bootstrap', $4::jsonb)`,
    [auditId, subjectId, assignmentId, JSON.stringify({ roleId, permissions })],
  );
  await client.query('COMMIT');
  process.stdout.write(`Access governance bootstrapped for subject ${subjectId}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
