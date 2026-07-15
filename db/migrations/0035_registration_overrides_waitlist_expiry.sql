CREATE TABLE registration.override_authorizations (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  offering_manifest_sha256 char(64) NOT NULL CHECK (offering_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  exception_type text NOT NULL CHECK (exception_type IN
    ('CREDIT_LIMIT','ADVISER_APPROVAL','TIMETABLE_CONFLICT','CAPACITY')),
  idempotency_key uuid NOT NULL UNIQUE,
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','REJECTED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  CHECK ((status='DRAFT' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status<>'DRAFT' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by<>requested_by))
);

CREATE TABLE registration.request_override_usages (
  request_id uuid NOT NULL REFERENCES registration.requests(id),
  authorization_id uuid NOT NULL UNIQUE REFERENCES registration.override_authorizations(id),
  exception_type text NOT NULL CHECK (exception_type IN
    ('CREDIT_LIMIT','ADVISER_APPROVAL','TIMETABLE_CONFLICT','CAPACITY')),
  used_by text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id,exception_type)
);

CREATE TABLE registration.waitlist_terms (
  request_id uuid PRIMARY KEY REFERENCES registration.requests(id),
  expires_at timestamptz NOT NULL,
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at>created_at)
);
CREATE INDEX waitlist_terms_due_idx ON registration.waitlist_terms(expires_at,request_id);

CREATE TABLE registration.waitlist_expirations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES registration.requests(id),
  expires_at timestamptz NOT NULL,
  policy_reference text NOT NULL,
  expired_by text NOT NULL,
  expired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE registration.request_eligibility_snapshots
  DROP CONSTRAINT request_eligibility_snapshots_check,
  DROP CONSTRAINT request_eligibility_snapshots_check1,
  DROP CONSTRAINT request_eligibility_snapshots_timetable_conflict_count_check,
  ADD CONSTRAINT registration_timetable_conflict_count_nonnegative CHECK (timetable_conflict_count>=0);

CREATE OR REPLACE FUNCTION registration.assert_override_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE student student.records%ROWTYPE; period registration.academic_periods%ROWTYPE;
BEGIN
  SELECT * INTO student FROM student.records WHERE id=NEW.student_id FOR SHARE;
  SELECT * INTO period FROM registration.academic_periods WHERE id=NEW.period_id FOR SHARE;
  IF student.id IS NULL OR period.id IS NULL OR period.status<>'PUBLISHED'
    OR student.scope_type<>NEW.scope_type OR student.scope_id<>NEW.scope_id
    OR period.scope_type<>NEW.scope_type OR period.scope_id<>NEW.scope_id
    THEN RAISE EXCEPTION 'invalid registration override authorization'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_override_authorization_consistency BEFORE INSERT
ON registration.override_authorizations FOR EACH ROW EXECUTE FUNCTION registration.assert_override_authorization();

CREATE OR REPLACE FUNCTION registration.protect_override_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'DRAFT'
    OR to_jsonb(NEW)-ARRAY['status','record_version','decided_by','decided_at']
      <>to_jsonb(OLD)-ARRAY['status','record_version','decided_by','decided_at']
    THEN RAISE EXCEPTION 'registration override authorization is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_override_authorizations_guard BEFORE UPDATE OR DELETE
ON registration.override_authorizations FOR EACH ROW EXECUTE FUNCTION registration.protect_override_authorization();

CREATE OR REPLACE FUNCTION registration.assert_override_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; auth registration.override_authorizations%ROWTYPE;
  actual_manifest text;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO auth FROM registration.override_authorizations
    WHERE id=NEW.authorization_id FOR UPDATE;
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex')
    INTO actual_manifest FROM registration.request_items WHERE request_id=NEW.request_id;
  IF request.id IS NULL OR request.status<>'PENDING' OR auth.id IS NULL
    OR auth.status<>'APPROVED' OR auth.student_id<>request.student_id
    OR auth.period_id<>request.period_id OR auth.scope_type<>request.scope_type
    OR auth.scope_id<>request.scope_id OR auth.exception_type<>NEW.exception_type
    OR auth.offering_manifest_sha256<>actual_manifest OR request.submitted_by<>NEW.used_by
    THEN RAISE EXCEPTION 'invalid registration override usage'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_override_usage_consistency BEFORE INSERT ON registration.request_override_usages
FOR EACH ROW EXECUTE FUNCTION registration.assert_override_usage();
CREATE TRIGGER registration_override_usages_no_mutation BEFORE UPDATE OR DELETE
ON registration.request_override_usages FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_eligibility_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; approval registration.adviser_approvals%ROWTYPE;
  actual_manifest text; credit_override boolean; adviser_override boolean; timetable_override boolean;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex')
    INTO actual_manifest FROM registration.request_items WHERE request_id=NEW.request_id;
  SELECT EXISTS(SELECT 1 FROM registration.request_override_usages
      WHERE request_id=NEW.request_id AND exception_type='CREDIT_LIMIT'),
    EXISTS(SELECT 1 FROM registration.request_override_usages
      WHERE request_id=NEW.request_id AND exception_type='ADVISER_APPROVAL'),
    EXISTS(SELECT 1 FROM registration.request_override_usages
      WHERE request_id=NEW.request_id AND exception_type='TIMETABLE_CONFLICT')
    INTO credit_override,adviser_override,timetable_override;
  IF request.id IS NULL OR request.status<>'PENDING' OR request.submitted_by<>NEW.created_by
    OR actual_manifest IS NULL THEN RAISE EXCEPTION 'invalid registration eligibility snapshot'; END IF;
  IF NEW.requested_credit_units>NEW.maximum_credit_units AND NOT credit_override
    THEN RAISE EXCEPTION 'credit limit override required'; END IF;
  IF NEW.adviser_required AND NEW.adviser_approval_id IS NULL AND NOT adviser_override
    THEN RAISE EXCEPTION 'adviser approval override required'; END IF;
  IF NOT NEW.adviser_required AND NEW.adviser_approval_id IS NOT NULL
    THEN RAISE EXCEPTION 'unexpected adviser approval'; END IF;
  IF NEW.timetable_conflict_count>0 AND NOT timetable_override
    THEN RAISE EXCEPTION 'timetable conflict override required'; END IF;
  IF NEW.adviser_approval_id IS NOT NULL THEN
    SELECT * INTO approval FROM registration.adviser_approvals WHERE id=NEW.adviser_approval_id FOR SHARE;
    IF approval.id IS NULL OR approval.student_id<>request.student_id OR approval.period_id<>request.period_id
      OR approval.offering_manifest_sha256<>actual_manifest OR approval.scope_type<>request.scope_type
      OR approval.scope_id<>request.scope_id THEN RAISE EXCEPTION 'invalid adviser approval for request'; END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION registration.assert_waitlist_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  IF request.id IS NULL OR request.status<>'WAITLISTED' OR request.decided_by<>NEW.created_by
    THEN RAISE EXCEPTION 'invalid waitlist expiry terms'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_waitlist_terms_consistency BEFORE INSERT ON registration.waitlist_terms
FOR EACH ROW EXECUTE FUNCTION registration.assert_waitlist_terms();
CREATE TRIGGER registration_waitlist_terms_no_mutation BEFORE UPDATE OR DELETE ON registration.waitlist_terms
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_waitlist_expirations_no_mutation BEFORE UPDATE OR DELETE
ON registration.waitlist_expirations FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
