CREATE SCHEMA curriculum;

CREATE TABLE curriculum.regulation_versions (
  id uuid PRIMARY KEY,
  regulation_key text NOT NULL CHECK (regulation_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 200),
  rule_schema_version text NOT NULL CHECK (rule_schema_version ~ '^[a-zA-Z0-9_.-]{1,50}$'),
  rule_document jsonb NOT NULL CHECK (jsonb_typeof(rule_document) = 'object'),
  impact_summary text NOT NULL CHECK (char_length(impact_summary) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'RETIRED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  policy_decision_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (regulation_key, version),
  CONSTRAINT regulation_publication_consistency CHECK (
    (status = 'DRAFT' AND published_by IS NULL AND published_at IS NULL
      AND policy_decision_reference IS NULL)
    OR (status <> 'DRAFT' AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND char_length(policy_decision_reference) BETWEEN 3 AND 200)
  )
);

CREATE INDEX regulation_versions_scope_idx
  ON curriculum.regulation_versions(scope_type, scope_id, status, regulation_key, version DESC);

CREATE OR REPLACE FUNCTION curriculum.protect_published_regulation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'published regulation versions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
    NEW.regulation_key <> OLD.regulation_key OR NEW.version <> OLD.version
    OR NEW.title <> OLD.title OR NEW.scope_type <> OLD.scope_type OR NEW.scope_id <> OLD.scope_id
    OR NEW.rule_schema_version <> OLD.rule_schema_version
    OR NEW.rule_document <> OLD.rule_document OR NEW.impact_summary <> OLD.impact_summary
    OR NEW.policy_decision_reference <> OLD.policy_decision_reference
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
    OR NEW.published_by <> OLD.published_by OR NEW.published_at <> OLD.published_at
  ) THEN
    RAISE EXCEPTION 'published regulation content is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER regulation_versions_immutable
BEFORE UPDATE OR DELETE ON curriculum.regulation_versions
FOR EACH ROW EXECUTE FUNCTION curriculum.protect_published_regulation();
