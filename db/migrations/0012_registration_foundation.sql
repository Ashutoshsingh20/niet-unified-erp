CREATE SCHEMA registration;

CREATE TABLE registration.academic_periods (
  id uuid PRIMARY KEY,
  period_key text NOT NULL CHECK (period_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  policy_decision_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (period_key, version),
  CHECK (ends_at > starts_at),
  CONSTRAINT academic_period_publication_consistency CHECK (
    (status = 'DRAFT' AND published_by IS NULL AND published_at IS NULL
      AND policy_decision_reference IS NULL)
    OR (status <> 'DRAFT' AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND char_length(policy_decision_reference) BETWEEN 3 AND 200)
  )
);

CREATE TABLE registration.offerings (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  offering_key text NOT NULL CHECK (offering_key ~ '^[a-zA-Z0-9_.-]{2,99}$'),
  course_key text NOT NULL CHECK (course_key ~ '^[a-zA-Z0-9_.-]{2,99}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  capacity integer NOT NULL CHECK (capacity > 0),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (period_id, offering_key),
  CONSTRAINT offering_publication_consistency CHECK (
    (status = 'DRAFT' AND published_by IS NULL AND published_at IS NULL)
    OR (status <> 'DRAFT' AND published_by IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE INDEX registration_offerings_period_idx
  ON registration.offerings(period_id, status, offering_key);

CREATE TABLE registration.requests (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'CONFIRMED', 'WAITLISTED', 'REJECTED', 'CANCELLED')
  ),
  idempotency_key uuid NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  CONSTRAINT registration_decision_consistency CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(decision_reason) BETWEEN 3 AND 1000)
  )
);

CREATE INDEX registration_requests_student_idx
  ON registration.requests(student_id, submitted_at DESC);
CREATE INDEX registration_requests_pending_idx
  ON registration.requests(scope_type, scope_id, submitted_at) WHERE status = 'PENDING';

CREATE TABLE registration.request_items (
  request_id uuid NOT NULL REFERENCES registration.requests(id),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  PRIMARY KEY (request_id, offering_id)
);

CREATE TABLE registration.decisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES registration.requests(id),
  outcome text NOT NULL CHECK (outcome IN ('CONFIRMED', 'WAITLISTED', 'REJECTED')),
  regulation_id uuid NOT NULL REFERENCES curriculum.regulation_versions(id),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,50}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace) = 'object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION registration.protect_published_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published registration configuration cannot be deleted'; END IF;
    IF to_jsonb(NEW) - ARRAY['status', 'record_version']
       <> to_jsonb(OLD) - ARRAY['status', 'record_version'] THEN
      RAISE EXCEPTION 'published registration configuration is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER academic_periods_immutable
BEFORE UPDATE OR DELETE ON registration.academic_periods
FOR EACH ROW EXECUTE FUNCTION registration.protect_published_configuration();

CREATE TRIGGER offerings_immutable
BEFORE UPDATE OR DELETE ON registration.offerings
FOR EACH ROW EXECUTE FUNCTION registration.protect_published_configuration();

CREATE OR REPLACE FUNCTION registration.reject_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registration decisions are append-only';
END;
$$;

CREATE TRIGGER registration_decisions_no_mutation
BEFORE UPDATE OR DELETE ON registration.decisions
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
