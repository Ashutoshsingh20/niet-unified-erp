ALTER TABLE workflow.instances
  ADD COLUMN scope_type text NOT NULL DEFAULT 'institution'
    CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  ADD COLUMN scope_id text NOT NULL DEFAULT '*';

CREATE INDEX workflow_instances_scope_idx
  ON workflow.instances(scope_type, scope_id, submitted_at DESC);

