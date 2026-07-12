ALTER TABLE platform.outbox_events
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN failed_at timestamptz;

DROP INDEX platform.outbox_unpublished_idx;
CREATE INDEX outbox_publishable_idx
  ON platform.outbox_events(next_attempt_at, occurred_at)
  WHERE published_at IS NULL AND failed_at IS NULL;

