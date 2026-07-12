CREATE SCHEMA teaching;

CREATE TABLE teaching.sessions (
  id uuid PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  session_key text NOT NULL CHECK (session_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (
    status IN ('PLANNED', 'OPEN', 'FINALIZED', 'CANCELLED')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_by text,
  opened_at timestamptz,
  finalized_by text,
  finalized_at timestamptz,
  finalization_reason text,
  observation_set_sha256 text CHECK (observation_set_sha256 IS NULL OR observation_set_sha256 ~ '^[a-f0-9]{64}$'),
  UNIQUE (offering_id, session_key),
  CHECK (ends_at > starts_at),
  CONSTRAINT teaching_session_state_consistency CHECK (
    (status = 'PLANNED' AND opened_at IS NULL AND finalized_at IS NULL)
    OR (status = 'OPEN' AND opened_at IS NOT NULL AND finalized_at IS NULL)
    OR (status = 'FINALIZED' AND opened_at IS NOT NULL AND finalized_at IS NOT NULL
      AND char_length(finalization_reason) BETWEEN 3 AND 1000
      AND observation_set_sha256 IS NOT NULL)
    OR status = 'CANCELLED'
  )
);

CREATE INDEX teaching_sessions_offering_idx ON teaching.sessions(offering_id, starts_at);

CREATE TABLE teaching.attendance_observations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES teaching.sessions(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  presence_state text NOT NULL CHECK (
    presence_state IN ('OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED')
  ),
  source_kind text NOT NULL CHECK (source_kind ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  source_reference text CHECK (source_reference IS NULL OR char_length(source_reference) <= 300),
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, student_id)
);

CREATE TABLE teaching.attendance_correction_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES teaching.sessions(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  proposed_state text NOT NULL CHECK (
    proposed_state IN ('OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED')
  ),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  CONSTRAINT attendance_correction_request_state CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX attendance_correction_requests_pending_idx
  ON teaching.attendance_correction_requests(session_id, requested_at) WHERE status = 'PENDING';

CREATE TABLE teaching.attendance_corrections (
  id uuid PRIMARY KEY,
  correction_request_id uuid NOT NULL UNIQUE REFERENCES teaching.attendance_correction_requests(id),
  session_id uuid NOT NULL REFERENCES teaching.sessions(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  previous_state text NOT NULL CHECK (
    previous_state IN ('OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED')
  ),
  corrected_state text NOT NULL CHECK (
    corrected_state IN ('OBSERVED_PRESENT', 'OBSERVED_ABSENT', 'NOT_OBSERVED')
  ),
  correction_sequence integer NOT NULL CHECK (correction_sequence > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  requested_by text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (previous_state <> corrected_state),
  CHECK (requested_by <> approved_by),
  UNIQUE (session_id, student_id, correction_sequence)
);

CREATE INDEX attendance_corrections_effective_idx
  ON teaching.attendance_corrections(session_id, student_id, correction_sequence DESC);

CREATE OR REPLACE FUNCTION teaching.reject_attendance_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance evidence is append-only';
END;
$$;

CREATE TRIGGER attendance_observations_no_mutation
BEFORE UPDATE OR DELETE ON teaching.attendance_observations
FOR EACH ROW EXECUTE FUNCTION teaching.reject_attendance_evidence_mutation();

CREATE TRIGGER attendance_corrections_no_mutation
BEFORE UPDATE OR DELETE ON teaching.attendance_corrections
FOR EACH ROW EXECUTE FUNCTION teaching.reject_attendance_evidence_mutation();
