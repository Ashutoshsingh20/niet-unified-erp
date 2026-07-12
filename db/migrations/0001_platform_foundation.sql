CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS access;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS platform.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE platform.audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_subject_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  correlation_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrity_hash text GENERATED ALWAYS AS (
    encode(digest(
      id::text || '|' || actor_subject_id || '|' || action || '|' || resource_type || '|'
      || resource_id || '|' || outcome || '|' || correlation_id || '|' || details::text,
      'sha256'
    ), 'hex')
  ) STORED
);

CREATE INDEX audit_events_resource_idx
  ON platform.audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx
  ON platform.audit_events (actor_subject_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION platform.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are immutable';
END;
$$;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE OR DELETE ON platform.audit_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_audit_mutation();

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id uuid,
  classification text NOT NULL CHECK (
    classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE INDEX outbox_unpublished_idx
  ON platform.outbox_events (occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE access.roles (
  id uuid PRIMARY KEY,
  role_key text NOT NULL UNIQUE CHECK (role_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 150),
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.role_permissions (
  role_id uuid NOT NULL REFERENCES access.roles(id),
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_.:-]{2,149}$'),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE access.subject_role_assignments (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL,
  role_id uuid NOT NULL REFERENCES access.roles(id),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  granted_by text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  revoked_at timestamptz,
  revoked_by text,
  CONSTRAINT assignments_effective_range CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT assignments_revocation_consistency CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE INDEX subject_role_assignments_effective_idx
  ON access.subject_role_assignments (subject_id, effective_from, effective_until)
  WHERE revoked_at IS NULL;

CREATE TABLE workflow.definitions (
  id uuid PRIMARY KEY,
  definition_key text NOT NULL CHECK (definition_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  submit_permission text NOT NULL,
  approval_permission text NOT NULL,
  prohibit_requester_approval boolean NOT NULL DEFAULT true,
  effective_from timestamptz,
  effective_until timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  CONSTRAINT definitions_key_version_unique UNIQUE (definition_key, version),
  CONSTRAINT definitions_effective_range CHECK (
    effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from
  )
);

CREATE UNIQUE INDEX definitions_one_published_version_idx
  ON workflow.definitions (definition_key)
  WHERE status = 'PUBLISHED';

CREATE TABLE workflow.instances (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES workflow.definitions(id),
  requester_subject_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  request_data jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  CONSTRAINT instances_decision_consistency CHECK (
    (status = 'PENDING' AND decided_at IS NULL AND decided_by IS NULL)
    OR (status <> 'PENDING' AND decided_at IS NOT NULL)
  )
);

CREATE INDEX instances_requester_idx
  ON workflow.instances (requester_subject_id, submitted_at DESC);

CREATE TABLE workflow.tasks (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES workflow.instances(id),
  required_permission text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  completed_by text,
  decision_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT tasks_completion_consistency CHECK (
    (status = 'OPEN' AND completed_at IS NULL AND completed_by IS NULL)
    OR (status <> 'OPEN' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX tasks_open_permission_idx
  ON workflow.tasks (required_permission, created_at)
  WHERE status = 'OPEN';
