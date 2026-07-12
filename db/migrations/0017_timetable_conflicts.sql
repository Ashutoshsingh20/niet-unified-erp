CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE registration.timetable_meetings (
  id uuid PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  meeting_key text NOT NULL CHECK (meeting_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1438),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1439),
  room_key text NOT NULL CHECK (room_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  instructor_subject_id text NOT NULL CHECK (char_length(instructor_subject_id) BETWEEN 1 AND 200),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','CANCELLED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  policy_decision_reference text,
  UNIQUE (offering_id,meeting_key),
  CHECK (end_minute > start_minute),
  CHECK ((status='DRAFT' AND published_by IS NULL AND published_at IS NULL
      AND policy_decision_reference IS NULL)
    OR (status<>'DRAFT' AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND char_length(policy_decision_reference) BETWEEN 3 AND 300)),
  EXCLUDE USING gist (weekday WITH =, room_key WITH =,
    int4range(start_minute::integer,end_minute::integer,'[)') WITH &&)
    WHERE (status='PUBLISHED'),
  EXCLUDE USING gist (weekday WITH =, instructor_subject_id WITH =,
    int4range(start_minute::integer,end_minute::integer,'[)') WITH &&)
    WHERE (status='PUBLISHED'),
  EXCLUDE USING gist (weekday WITH =, offering_id WITH =,
    int4range(start_minute::integer,end_minute::integer,'[)') WITH &&)
    WHERE (status='PUBLISHED')
);
CREATE INDEX timetable_meetings_offering_idx
  ON registration.timetable_meetings(offering_id,status,weekday,start_minute);

CREATE OR REPLACE FUNCTION registration.protect_published_meeting()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'DRAFT' THEN
    IF TG_OP='DELETE' OR to_jsonb(NEW)-ARRAY['status','record_version']
      <> to_jsonb(OLD)-ARRAY['status','record_version'] THEN
      RAISE EXCEPTION 'published timetable meeting is immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER timetable_meetings_immutable BEFORE UPDATE OR DELETE
ON registration.timetable_meetings FOR EACH ROW
EXECUTE FUNCTION registration.protect_published_meeting();
