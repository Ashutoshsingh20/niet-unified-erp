import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required');
}

const client = new pg.Client({ connectionString: databaseUrl, application_name: 'niet-erp-db-verifier' });
await client.connect();

try {
  const requiredTables = [
    'access.roles',
    'access.role_permissions',
    'access.subject_role_assignments',
    'access.delegations',
    'access.reviews',
    'access.review_items',
    'organization.units',
    'documents.types',
    'documents.records',
    'notifications.templates',
    'notifications.preferences',
    'notifications.entries',
    'notifications.push_events',
    'search.records',
    'student.records',
    'student.status_history',
    'student.identifiers',
    'student.identity_match_exceptions',
    'curriculum.regulation_versions',
    'registration.academic_periods',
    'registration.offerings',
    'registration.requests',
    'registration.request_items',
    'registration.decisions',
    'teaching.sessions',
    'teaching.attendance_observations',
    'teaching.attendance_correction_requests',
    'teaching.attendance_corrections',
    'finance.student_accounts',
    'finance.postings',
    'finance.ledger_entries',
    'migration.batches',
    'migration.staged_rows',
    'migration.control_totals',
    'migration.approvals',
    'admissions.applications',
    'admissions.submissions',
    'admissions.decisions',
    'registration.timetable_meetings',
    'admissions.offers',
    'admissions.conversions',
    'curriculum.programme_versions',
    'student.programme_enrolments',
    'student.holds',
    'student.hold_releases',
    'registration.waitlist_entries',
    'registration.waitlist_promotions',
    'registration.withdrawals',
    'platform.audit_events',
    'platform.outbox_events',
    'workflow.definitions',
    'workflow.instances',
    'workflow.tasks',
  ];
  for (const table of requiredTables) {
    const result = await client.query('SELECT to_regclass($1) AS table_name', [table]);
    if (result.rows[0]?.table_name !== table) {
      throw new Error(`Required table ${table} is missing`);
    }
  }

  const outboxColumns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'platform' AND table_name = 'outbox_events'
       AND column_name IN ('next_attempt_at', 'failed_at')`,
  );
  if (outboxColumns.rowCount !== 2) throw new Error('Outbox retry columns are missing');

  const auditId = randomUUID();
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO platform.audit_events
      (id, actor_subject_id, action, resource_type, resource_id, outcome, correlation_id, details)
     VALUES ($1, 'database-verifier', 'verification.created', 'verification', $2, 'SUCCEEDED',
             'database-verifier', '{}'::jsonb)`,
    [auditId, auditId],
  );
  const hash = await client.query(
    'SELECT integrity_hash FROM platform.audit_events WHERE id = $1',
    [auditId],
  );
  if (!/^[a-f0-9]{64}$/.test(hash.rows[0]?.integrity_hash ?? '')) {
    throw new Error('Audit integrity hash was not generated');
  }

  await client.query('SAVEPOINT before_forbidden_mutation');
  let mutationRejected = false;
  try {
    await client.query(
      "UPDATE platform.audit_events SET action = 'verification.tampered' WHERE id = $1",
      [auditId],
    );
  } catch (error) {
    mutationRejected = error instanceof Error && error.message.includes('audit events are immutable');
    await client.query('ROLLBACK TO SAVEPOINT before_forbidden_mutation');
  }
  if (!mutationRejected) {
    throw new Error('Audit mutation was not rejected by PostgreSQL');
  }
  await client.query('ROLLBACK');
  process.stdout.write('Database structure and immutable-audit controls verified\n');
} finally {
  await client.end();
}
