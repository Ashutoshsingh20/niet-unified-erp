CREATE TABLE student.holds (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  hold_key text NOT NULL CHECK (hold_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  effect text NOT NULL CHECK (effect IN ('REGISTRATION_SUBMISSION')),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE','RELEASED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  raised_by text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_by text,
  activated_at timestamptz,
  released_at timestamptz,
  CHECK ((status='PROPOSED' AND activated_by IS NULL AND activated_at IS NULL AND released_at IS NULL)
    OR (status='ACTIVE' AND activated_by IS NOT NULL AND activated_at IS NOT NULL AND released_at IS NULL)
    OR (status='RELEASED' AND activated_by IS NOT NULL AND activated_at IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (activated_by IS NULL OR raised_by<>activated_by)
);
CREATE UNIQUE INDEX student_holds_active_effect_idx
  ON student.holds(student_id,hold_key,effect) WHERE status IN ('PROPOSED','ACTIVE');
CREATE INDEX student_holds_student_idx ON student.holds(student_id,status,raised_at DESC);

CREATE TABLE student.hold_releases (
  id uuid PRIMARY KEY,
  hold_id uuid NOT NULL UNIQUE REFERENCES student.holds(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  released_by text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION student.protect_hold_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.student_id<>OLD.student_id OR NEW.hold_key<>OLD.hold_key
    OR NEW.effect<>OLD.effect OR NEW.policy_reference<>OLD.policy_reference OR NEW.reason<>OLD.reason
    OR NEW.evidence_reference<>OLD.evidence_reference OR NEW.scope_type<>OLD.scope_type
    OR NEW.scope_id<>OLD.scope_id OR NEW.raised_by<>OLD.raised_by OR NEW.raised_at<>OLD.raised_at
    THEN RAISE EXCEPTION 'student hold evidence is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER student_holds_evidence_guard BEFORE UPDATE OR DELETE ON student.holds
FOR EACH ROW EXECUTE FUNCTION student.protect_hold_evidence();
CREATE TRIGGER student_hold_releases_no_mutation BEFORE UPDATE OR DELETE ON student.hold_releases
FOR EACH ROW EXECUTE FUNCTION student.reject_history_mutation();
