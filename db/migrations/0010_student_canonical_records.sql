CREATE SCHEMA student;

CREATE TABLE student.records (
  id uuid PRIMARY KEY,
  subject_id text,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'PROVISIONAL' CHECK (
    status IN ('PROVISIONAL', 'ACTIVE', 'SUSPENDED', 'ON_LEAVE', 'COMPLETED', 'WITHDRAWN', 'TERMINATED')
  ),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 200),
  source_system text NOT NULL CHECK (source_system ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  source_extracted_at timestamptz NOT NULL,
  mapping_version text NOT NULL CHECK (mapping_version ~ '^[a-zA-Z0-9_.-]{1,50}$'),
  source_row_sha256 text NOT NULL CHECK (source_row_sha256 ~ '^[a-f0-9]{64}$'),
  migration_batch_id uuid,
  idempotency_key uuid NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_system, source_key)
);

CREATE INDEX student_records_scope_idx ON student.records(scope_type, scope_id, created_at DESC);
CREATE INDEX student_records_subject_idx ON student.records(subject_id) WHERE subject_id IS NOT NULL;

CREATE TABLE student.status_history (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  from_status text,
  to_status text NOT NULL,
  record_version integer NOT NULL CHECK (record_version > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  rule_version text,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (student_id, record_version)
);

CREATE TABLE student.identifiers (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  identifier_type text NOT NULL CHECK (identifier_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  authority text NOT NULL CHECK (authority ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  lookup_fingerprint text NOT NULL CHECK (lookup_fingerprint ~ '^[a-f0-9]{64}$'),
  encrypted_value bytea NOT NULL CHECK (octet_length(encrypted_value) >= 32),
  display_hint text CHECK (display_hint IS NULL OR char_length(display_hint) <= 20),
  classification text NOT NULL DEFAULT 'RESTRICTED' CHECK (classification = 'RESTRICTED'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (identifier_type, authority, lookup_fingerprint)
);

CREATE INDEX student_identifiers_student_idx ON student.identifiers(student_id) WHERE revoked_at IS NULL;

CREATE TABLE student.identity_match_exceptions (
  id uuid PRIMARY KEY,
  source_system text NOT NULL,
  source_key text NOT NULL,
  candidate_student_ids uuid[] NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  resolution_reason text,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT identity_exception_resolution_consistency CHECK (
    (status = 'OPEN' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status <> 'OPEN' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
        AND char_length(resolution_reason) >= 3)
  )
);

CREATE OR REPLACE FUNCTION student.reject_provenance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_system <> OLD.source_system OR NEW.source_key <> OLD.source_key
     OR NEW.source_extracted_at <> OLD.source_extracted_at
     OR NEW.mapping_version <> OLD.mapping_version
     OR NEW.source_row_sha256 <> OLD.source_row_sha256
     OR NEW.migration_batch_id IS DISTINCT FROM OLD.migration_batch_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'student source provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER student_records_provenance_immutable
BEFORE UPDATE ON student.records
FOR EACH ROW EXECUTE FUNCTION student.reject_provenance_mutation();

CREATE OR REPLACE FUNCTION student.reject_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'student history is append-only';
END;
$$;

CREATE TRIGGER student_status_history_no_update
BEFORE UPDATE OR DELETE ON student.status_history
FOR EACH ROW EXECUTE FUNCTION student.reject_history_mutation();
