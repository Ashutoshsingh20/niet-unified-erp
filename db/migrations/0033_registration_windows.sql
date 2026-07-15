CREATE TABLE registration.windows (
  id uuid PRIMARY KEY,
  window_key text NOT NULL CHECK (window_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version>0),
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  window_type text NOT NULL CHECK (window_type IN ('SUBMISSION','ADD_DROP')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  policy_decision_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (window_key,version),
  CHECK (closes_at>opens_at),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status='PUBLISHED' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND created_by<>published_by)),
  EXCLUDE USING gist (period_id WITH =,window_type WITH =,
    tstzrange(opens_at,closes_at,'[)') WITH &&) WHERE (status='PUBLISHED')
);
CREATE INDEX registration_active_windows_idx
  ON registration.windows(period_id,window_type,opens_at,closes_at) WHERE status='PUBLISHED';

CREATE OR REPLACE FUNCTION registration.protect_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE period registration.academic_periods%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'registration window evidence is append-only'; END IF;
  SELECT * INTO period FROM registration.academic_periods WHERE id=OLD.period_id FOR SHARE;
  IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
    OR NEW.window_key<>OLD.window_key OR NEW.version<>OLD.version OR NEW.period_id<>OLD.period_id
    OR NEW.window_type<>OLD.window_type OR NEW.title<>OLD.title OR NEW.opens_at<>OLD.opens_at
    OR NEW.closes_at<>OLD.closes_at OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at OR NEW.published_by=OLD.created_by
    OR period.id IS NULL OR period.status<>'PUBLISHED' OR period.scope_type<>OLD.scope_type
    OR period.scope_id<>OLD.scope_id THEN RAISE EXCEPTION 'invalid registration window publication'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_window_guard BEFORE UPDATE OR DELETE ON registration.windows
FOR EACH ROW EXECUTE FUNCTION registration.protect_window();
