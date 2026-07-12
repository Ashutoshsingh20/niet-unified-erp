CREATE SCHEMA admissions;

CREATE TABLE admissions.applications (
  id uuid PRIMARY KEY,
  applicant_subject_id text NOT NULL,
  programme_key text NOT NULL CHECK (programme_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload)>16),
  encryption_key_reference text NOT NULL CHECK (char_length(encryption_key_reference) BETWEEN 3 AND 200),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','OFFERED','REJECTED','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  decided_at timestamptz,
  CHECK ((status='DRAFT' AND submitted_at IS NULL AND decided_at IS NULL)
    OR (status IN ('SUBMITTED','UNDER_REVIEW') AND submitted_at IS NOT NULL AND decided_at IS NULL)
    OR (status IN ('OFFERED','REJECTED') AND submitted_at IS NOT NULL AND decided_at IS NOT NULL)
    OR status='WITHDRAWN')
);
CREATE INDEX admissions_applications_scope_status_idx
  ON admissions.applications(scope_type,scope_id,status,created_at);

CREATE TABLE admissions.submissions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL UNIQUE REFERENCES admissions.applications(id),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_manifest_sha256 text NOT NULL CHECK (evidence_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE admissions.decisions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL UNIQUE REFERENCES admissions.applications(id),
  outcome text NOT NULL CHECK (outcome IN ('OFFERED','REJECTED')),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  regulation_reference text NOT NULL CHECK (char_length(regulation_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION admissions.reject_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'admissions evidence is append-only'; END; $$;
CREATE TRIGGER admissions_submissions_no_mutation BEFORE UPDATE OR DELETE ON admissions.submissions
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admissions_decisions_no_mutation BEFORE UPDATE OR DELETE ON admissions.decisions
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_application_payload()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'DRAFT' AND (NEW.encrypted_payload<>OLD.encrypted_payload
    OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.programme_key<>OLD.programme_key
    OR NEW.applicant_subject_id<>OLD.applicant_subject_id) THEN
    RAISE EXCEPTION 'submitted application payload is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admissions_application_payload_immutable BEFORE UPDATE ON admissions.applications
FOR EACH ROW EXECUTE FUNCTION admissions.protect_application_payload();
