CREATE SCHEMA IF NOT EXISTS organization;

CREATE TABLE organization.units (
  id uuid PRIMARY KEY,
  unit_key text NOT NULL UNIQUE CHECK (unit_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  unit_type text NOT NULL CHECK (unit_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 200),
  parent_id uuid REFERENCES organization.units(id),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_unit_effective_range CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT organization_unit_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX organization_units_parent_idx ON organization.units (parent_id);

ALTER TABLE access.roles DROP CONSTRAINT roles_role_key_key;
ALTER TABLE access.roles ADD CONSTRAINT roles_key_version_unique UNIQUE (role_key, version);
ALTER TABLE access.subject_role_assignments ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX roles_one_active_version_idx
  ON access.roles (role_key) WHERE status = 'ACTIVE';

CREATE TABLE access.delegations (
  id uuid PRIMARY KEY,
  delegator_subject_id text NOT NULL,
  delegate_subject_id text NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_.:-]{2,149}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by text,
  CONSTRAINT delegation_range CHECK (effective_until > effective_from),
  CONSTRAINT delegation_different_subjects CHECK (delegator_subject_id <> delegate_subject_id),
  CONSTRAINT delegation_revocation_consistency CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
    OR (status <> 'REVOKED' AND revoked_at IS NULL AND revoked_by IS NULL)
  )
);

CREATE INDEX delegations_delegate_effective_idx
  ON access.delegations (delegate_subject_id, effective_from, effective_until)
  WHERE status = 'ACTIVE';

CREATE TABLE access.reviews (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  reviewer_subject_id text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT access_review_completion_consistency CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  )
);

CREATE TABLE access.review_items (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES access.reviews(id),
  assignment_id uuid NOT NULL REFERENCES access.subject_role_assignments(id),
  decision text CHECK (decision IN ('RETAIN', 'REVOKE')),
  reason text,
  decided_at timestamptz,
  CONSTRAINT review_item_decision_consistency CHECK (
    (decision IS NULL AND reason IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND reason IS NOT NULL AND decided_at IS NOT NULL)
  ),
  UNIQUE (review_id, assignment_id)
);
