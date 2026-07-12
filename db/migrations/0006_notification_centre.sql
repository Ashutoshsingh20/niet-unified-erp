CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE notifications.templates (
  id uuid PRIMARY KEY,
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version > 0),
  title_template text NOT NULL CHECK (char_length(title_template) BETWEEN 1 AND 200),
  body_template text NOT NULL CHECK (char_length(body_template) BETWEEN 1 AND 2000),
  required_variables text[] NOT NULL DEFAULT '{}',
  allow_external_push boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (template_key, version)
);

CREATE UNIQUE INDEX notification_templates_one_active_idx
  ON notifications.templates(template_key) WHERE status = 'ACTIVE';

CREATE TABLE notifications.preferences (
  subject_id text PRIMARY KEY,
  external_push_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE notifications.entries (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES notifications.templates(id),
  recipient_subject_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  classification text NOT NULL CHECK (
    classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  action_path text CHECK (
    action_path IS NULL OR (char_length(action_path) BETWEEN 2 AND 501
      AND action_path ~ '^/[a-zA-Z0-9/_?=&.-]+$')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  archived_at timestamptz,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT notification_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX notification_entries_inbox_idx
  ON notifications.entries(recipient_subject_id, created_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX notification_entries_unread_idx
  ON notifications.entries(recipient_subject_id, created_at DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;

CREATE TABLE notifications.push_events (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL UNIQUE REFERENCES notifications.entries(id),
  recipient_subject_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE INDEX push_events_pending_idx ON notifications.push_events(created_at)
  WHERE status = 'PENDING';
