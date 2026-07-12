CREATE SCHEMA IF NOT EXISTS documents;

CREATE TABLE documents.types (
  id uuid PRIMARY KEY,
  type_key text NOT NULL CHECK (type_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 150),
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  allowed_mime_types text[] NOT NULL CHECK (cardinality(allowed_mime_types) BETWEEN 1 AND 50),
  max_size_bytes bigint NOT NULL CHECK (max_size_bytes BETWEEN 1 AND 1073741824),
  classification text NOT NULL CHECK (
    classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 36500),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (type_key, version)
);

CREATE UNIQUE INDEX document_types_one_active_version_idx
  ON documents.types(type_key) WHERE status = 'ACTIVE';

CREATE TABLE documents.records (
  id uuid PRIMARY KEY,
  document_type_id uuid NOT NULL REFERENCES documents.types(id),
  owner_subject_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  original_filename text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 255),
  declared_mime_type text NOT NULL,
  declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes > 0),
  declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
  quarantine_object_key text NOT NULL UNIQUE,
  clean_object_key text UNIQUE,
  status text NOT NULL CHECK (
    status IN ('UPLOAD_PENDING', 'QUARANTINED', 'SCAN_PASSED', 'CLEAN', 'REJECTED', 'DELETED')
  ),
  classification text NOT NULL CHECK (
    classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  retention_until timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  uploaded_at timestamptz,
  scanned_at timestamptz,
  scanner_engine text,
  scanner_signature_version text,
  detected_mime_type text,
  computed_sha256 text CHECK (computed_sha256 IS NULL OR computed_sha256 ~ '^[a-f0-9]{64}$'),
  rejection_reason text,
  CONSTRAINT document_scan_state_consistency CHECK (
    (status IN ('UPLOAD_PENDING', 'QUARANTINED') AND scanned_at IS NULL)
    OR (status IN ('SCAN_PASSED', 'CLEAN', 'REJECTED') AND scanned_at IS NOT NULL)
    OR status = 'DELETED'
  )
);

CREATE INDEX document_records_owner_idx
  ON documents.records(owner_subject_id, created_at DESC);
CREATE INDEX document_records_scope_idx
  ON documents.records(scope_type, scope_id, created_at DESC);
CREATE INDEX document_records_quarantine_idx
  ON documents.records(created_at) WHERE status = 'QUARANTINED';
