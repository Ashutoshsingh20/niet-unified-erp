CREATE SCHEMA IF NOT EXISTS search;

CREATE TABLE search.records (
  id uuid PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  source_version integer NOT NULL CHECK (source_version > 0),
  indexed_version integer NOT NULL DEFAULT 0 CHECK (indexed_version >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  required_permission text NOT NULL CHECK (required_permission ~ '^[a-z][a-z0-9_.:-]{2,149}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 200),
  classification text NOT NULL CHECK (
    classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  action_path text NOT NULL CHECK (
    char_length(action_path) BETWEEN 2 AND 501 AND action_path ~ '^/[a-zA-Z0-9/_?=&.-]+$'
  ),
  projection_status text NOT NULL CHECK (projection_status IN ('PENDING', 'INDEXED', 'FAILED')),
  index_attempts integer NOT NULL DEFAULT 0 CHECK (index_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  indexed_at timestamptz,
  UNIQUE (source_type, source_id),
  CONSTRAINT search_index_version_order CHECK (indexed_version <= source_version)
);

CREATE INDEX search_records_projection_idx
  ON search.records(next_attempt_at, updated_at)
  WHERE projection_status = 'PENDING' AND failed_at IS NULL;
CREATE INDEX search_records_source_idx ON search.records(source_type, source_id);

