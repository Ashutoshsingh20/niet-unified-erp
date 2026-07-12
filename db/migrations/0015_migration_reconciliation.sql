CREATE SCHEMA migration;

CREATE TABLE migration.batches (
  id uuid PRIMARY KEY,
  batch_key text NOT NULL UNIQUE CHECK (batch_key ~ '^[a-zA-Z0-9_.-]{3,100}$'),
  source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 2 AND 100),
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  mapping_version text NOT NULL CHECK (mapping_version ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'CREATED' CHECK (
    status IN ('CREATED','STAGED','VALIDATED','RECONCILED','APPROVED','APPLIED','REJECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by text,
  approved_at timestamptz,
  applied_by text,
  applied_at timestamptz,
  CHECK ((status IN ('APPROVED','APPLIED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status NOT IN ('APPROVED','APPLIED') AND approved_by IS NULL AND approved_at IS NULL)),
  CHECK ((status='APPLIED' AND applied_by IS NOT NULL AND applied_at IS NOT NULL)
    OR (status<>'APPLIED' AND applied_by IS NULL AND applied_at IS NULL))
);

CREATE TABLE migration.staged_rows (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES migration.batches(id),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 300),
  source_row_sha256 text NOT NULL CHECK (source_row_sha256 ~ '^[a-f0-9]{64}$'),
  extracted_at timestamptz NOT NULL,
  encrypted_candidate bytea NOT NULL CHECK (octet_length(encrypted_candidate) > 16),
  encryption_key_reference text NOT NULL CHECK (char_length(encryption_key_reference) BETWEEN 3 AND 200),
  staged_by text NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, source_key),
  UNIQUE (batch_id, source_row_sha256)
);

CREATE TABLE migration.control_totals (
  batch_id uuid PRIMARY KEY REFERENCES migration.batches(id),
  expected_row_count bigint NOT NULL CHECK (expected_row_count >= 0),
  staged_row_count bigint NOT NULL CHECK (staged_row_count >= 0),
  expected_rows_sha256 text NOT NULL CHECK (expected_rows_sha256 ~ '^[a-f0-9]{64}$'),
  staged_rows_sha256 text NOT NULL CHECK (staged_rows_sha256 ~ '^[a-f0-9]{64}$'),
  reconciled_by text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expected_row_count=staged_row_count),
  CHECK (expected_rows_sha256=staged_rows_sha256)
);

CREATE TABLE migration.approvals (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL UNIQUE REFERENCES migration.batches(id),
  reconciliation_reference text NOT NULL CHECK (char_length(reconciliation_reference) BETWEEN 3 AND 300),
  requested_by text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (requested_by<>approved_by)
);

CREATE OR REPLACE FUNCTION migration.reject_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'migration evidence is append-only'; END; $$;
CREATE TRIGGER migration_staged_rows_no_mutation BEFORE UPDATE OR DELETE ON migration.staged_rows
FOR EACH ROW EXECUTE FUNCTION migration.reject_evidence_mutation();
CREATE TRIGGER migration_control_totals_no_mutation BEFORE UPDATE OR DELETE ON migration.control_totals
FOR EACH ROW EXECUTE FUNCTION migration.reject_evidence_mutation();
CREATE TRIGGER migration_approvals_no_mutation BEFORE UPDATE OR DELETE ON migration.approvals
FOR EACH ROW EXECUTE FUNCTION migration.reject_evidence_mutation();
