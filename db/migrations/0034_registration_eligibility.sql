CREATE TABLE registration.adviser_approvals (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  offering_manifest_sha256 char(64) NOT NULL CHECK (offering_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE registration.request_eligibility_snapshots (
  request_id uuid PRIMARY KEY REFERENCES registration.requests(id),
  requested_credit_units numeric(8,2) NOT NULL CHECK (requested_credit_units>=0),
  maximum_credit_units numeric(8,2) NOT NULL CHECK (maximum_credit_units>=0),
  adviser_required boolean NOT NULL,
  adviser_approval_id uuid REFERENCES registration.adviser_approvals(id),
  timetable_conflict_count integer NOT NULL CHECK (timetable_conflict_count=0),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  CHECK (requested_credit_units<=maximum_credit_units),
  CHECK ((adviser_required AND adviser_approval_id IS NOT NULL)
    OR (NOT adviser_required AND adviser_approval_id IS NULL))
);

CREATE OR REPLACE FUNCTION registration.assert_adviser_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE student student.records%ROWTYPE; period registration.academic_periods%ROWTYPE;
BEGIN
  SELECT * INTO student FROM student.records WHERE id=NEW.student_id FOR SHARE;
  SELECT * INTO period FROM registration.academic_periods WHERE id=NEW.period_id FOR SHARE;
  IF student.id IS NULL OR period.id IS NULL OR period.status<>'PUBLISHED'
    OR student.scope_type<>NEW.scope_type OR student.scope_id<>NEW.scope_id
    OR period.scope_type<>NEW.scope_type OR period.scope_id<>NEW.scope_id
    OR student.subject_id=NEW.approved_by THEN RAISE EXCEPTION 'invalid adviser approval'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_adviser_approval_consistency BEFORE INSERT ON registration.adviser_approvals
FOR EACH ROW EXECUTE FUNCTION registration.assert_adviser_approval();
CREATE TRIGGER registration_adviser_approvals_no_mutation BEFORE UPDATE OR DELETE
ON registration.adviser_approvals FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_eligibility_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; approval registration.adviser_approvals%ROWTYPE;
  actual_manifest text;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex')
    INTO actual_manifest FROM registration.request_items WHERE request_id=NEW.request_id;
  IF request.id IS NULL OR request.status<>'PENDING' OR request.submitted_by<>NEW.created_by
    OR actual_manifest IS NULL THEN RAISE EXCEPTION 'invalid registration eligibility snapshot'; END IF;
  IF NEW.adviser_required THEN
    SELECT * INTO approval FROM registration.adviser_approvals WHERE id=NEW.adviser_approval_id FOR SHARE;
    IF approval.id IS NULL OR approval.student_id<>request.student_id OR approval.period_id<>request.period_id
      OR approval.offering_manifest_sha256<>actual_manifest OR approval.scope_type<>request.scope_type
      OR approval.scope_id<>request.scope_id THEN RAISE EXCEPTION 'invalid adviser approval for request'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_eligibility_snapshot_consistency BEFORE INSERT
ON registration.request_eligibility_snapshots FOR EACH ROW
EXECUTE FUNCTION registration.assert_eligibility_snapshot();
CREATE TRIGGER registration_eligibility_snapshots_no_mutation BEFORE UPDATE OR DELETE
ON registration.request_eligibility_snapshots FOR EACH ROW
EXECUTE FUNCTION registration.reject_decision_mutation();
