CREATE TABLE registration.waitlist_entries (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES registration.requests(id),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','PROMOTED','REMOVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  promoted_by text,
  promoted_at timestamptz,
  UNIQUE (request_id,offering_id),
  CHECK ((status='WAITING' AND promoted_by IS NULL AND promoted_at IS NULL)
    OR (status='PROMOTED' AND promoted_by IS NOT NULL AND promoted_at IS NOT NULL)
    OR status='REMOVED')
);
CREATE UNIQUE INDEX waitlist_student_offering_active_idx
  ON registration.waitlist_entries(student_id,offering_id) WHERE status='WAITING';
CREATE INDEX waitlist_fifo_idx ON registration.waitlist_entries(offering_id,created_at,id)
  WHERE status='WAITING';

CREATE TABLE registration.waitlist_promotions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES registration.requests(id),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  promoted_by text NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE registration.withdrawals (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES registration.requests(id),
  from_status text NOT NULL CHECK (from_status IN ('CONFIRMED','WAITLISTED')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  withdrawn_by text NOT NULL,
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER waitlist_promotions_no_mutation BEFORE UPDATE OR DELETE ON registration.waitlist_promotions
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_withdrawals_no_mutation BEFORE UPDATE OR DELETE ON registration.withdrawals
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.protect_waitlist_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.request_id<>OLD.request_id OR NEW.offering_id<>OLD.offering_id
    OR NEW.student_id<>OLD.student_id OR NEW.created_at<>OLD.created_at
    THEN RAISE EXCEPTION 'waitlist evidence is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER waitlist_entries_evidence_guard BEFORE UPDATE OR DELETE ON registration.waitlist_entries
FOR EACH ROW EXECUTE FUNCTION registration.protect_waitlist_evidence();
