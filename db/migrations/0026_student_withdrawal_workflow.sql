CREATE TABLE student.withdrawal_requests (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL UNIQUE REFERENCES student.records(id),
  idempotency_key uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','REJECTED','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE student.withdrawal_decisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES student.withdrawal_requests(id),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE student.programme_enrolment_withdrawals (
  id uuid PRIMARY KEY,
  withdrawal_request_id uuid NOT NULL REFERENCES student.withdrawal_requests(id),
  enrolment_id uuid NOT NULL UNIQUE REFERENCES student.programme_enrolments(id),
  from_status text NOT NULL CHECK (from_status IN ('PROVISIONAL','ACTIVE')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  withdrawn_by text NOT NULL,
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX student_withdrawal_worklist_idx
  ON student.withdrawal_requests(id) WHERE status='REQUESTED';

CREATE OR REPLACE FUNCTION student.assert_withdrawal_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record student.records%ROWTYPE;
  request student.withdrawal_requests%ROWTYPE;
  enrolment student.programme_enrolments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='withdrawal_requests' THEN
    SELECT * INTO record FROM student.records WHERE id=NEW.student_id FOR SHARE;
    IF record.id IS NULL OR record.subject_id IS NULL OR record.subject_id<>NEW.requested_by
      OR record.status IN ('WITHDRAWN','TERMINATED','COMPLETED') THEN
      RAISE EXCEPTION 'invalid student withdrawal request';
    END IF;
  ELSIF TG_TABLE_NAME='withdrawal_decisions' THEN
    SELECT * INTO request FROM student.withdrawal_requests WHERE id=NEW.request_id FOR SHARE;
    IF request.id IS NULL OR request.status<>'REQUESTED' OR request.requested_by=NEW.decided_by THEN
      RAISE EXCEPTION 'invalid student withdrawal decision';
    END IF;
  ELSIF TG_TABLE_NAME='programme_enrolment_withdrawals' THEN
    SELECT * INTO request FROM student.withdrawal_requests WHERE id=NEW.withdrawal_request_id FOR SHARE;
    SELECT * INTO enrolment FROM student.programme_enrolments WHERE id=NEW.enrolment_id FOR SHARE;
    IF request.id IS NULL OR enrolment.id IS NULL OR enrolment.student_id<>request.student_id
      OR enrolment.status<>NEW.from_status OR enrolment.status NOT IN ('PROVISIONAL','ACTIVE') THEN
      RAISE EXCEPTION 'invalid programme enrolment withdrawal evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION student.protect_withdrawal_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision student.withdrawal_decisions%ROWTYPE;
BEGIN
  IF OLD.status<>'REQUESTED' OR NEW.student_id<>OLD.student_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.reason<>OLD.reason
    OR NEW.requested_by<>OLD.requested_by OR NEW.requested_at<>OLD.requested_at
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'student withdrawal request evidence is immutable';
  END IF;
  SELECT * INTO decision FROM student.withdrawal_decisions WHERE request_id=OLD.id;
  IF decision.id IS NULL OR (decision.decision='APPROVED' AND NEW.status<>'WITHDRAWN')
    OR (decision.decision='REJECTED' AND NEW.status<>'REJECTED') THEN
    RAISE EXCEPTION 'withdrawal request status does not match decision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION student.require_status_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>OLD.status AND NOT EXISTS (
    SELECT 1 FROM student.status_history h WHERE h.student_id=OLD.id
      AND h.from_status=OLD.status AND h.to_status=NEW.status AND h.record_version=NEW.version) THEN
    RAISE EXCEPTION 'student status transition requires append-only history';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER student_withdrawal_request_consistency
BEFORE INSERT ON student.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION student.assert_withdrawal_evidence();
CREATE TRIGGER student_withdrawal_decision_consistency
BEFORE INSERT ON student.withdrawal_decisions
FOR EACH ROW EXECUTE FUNCTION student.assert_withdrawal_evidence();
CREATE TRIGGER student_programme_withdrawal_consistency
BEFORE INSERT ON student.programme_enrolment_withdrawals
FOR EACH ROW EXECUTE FUNCTION student.assert_withdrawal_evidence();
CREATE TRIGGER student_withdrawal_request_transition
BEFORE UPDATE ON student.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION student.protect_withdrawal_request();
CREATE TRIGGER student_withdrawal_requests_no_delete
BEFORE DELETE ON student.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION student.reject_history_mutation();
CREATE TRIGGER student_withdrawal_decisions_no_mutation
BEFORE UPDATE OR DELETE ON student.withdrawal_decisions
FOR EACH ROW EXECUTE FUNCTION student.reject_history_mutation();
CREATE TRIGGER student_programme_withdrawals_no_mutation
BEFORE UPDATE OR DELETE ON student.programme_enrolment_withdrawals
FOR EACH ROW EXECUTE FUNCTION student.reject_history_mutation();
CREATE TRIGGER student_status_requires_history
BEFORE UPDATE OF status ON student.records
FOR EACH ROW EXECUTE FUNCTION student.require_status_history();
