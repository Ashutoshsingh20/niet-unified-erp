CREATE TABLE curriculum.programme_versions (
  id uuid PRIMARY KEY,
  programme_key text NOT NULL CHECK (programme_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  regulation_id uuid NOT NULL REFERENCES curriculum.regulation_versions(id),
  structure_manifest_sha256 text NOT NULL CHECK (structure_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  policy_decision_reference text,
  UNIQUE (programme_key,version),
  CHECK ((status='DRAFT' AND published_by IS NULL AND published_at IS NULL
      AND policy_decision_reference IS NULL)
    OR (status<>'DRAFT' AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND char_length(policy_decision_reference) BETWEEN 3 AND 300))
);

CREATE TABLE student.programme_enrolments (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  programme_version_id uuid NOT NULL REFERENCES curriculum.programme_versions(id),
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'PROVISIONAL' CHECK (
    status IN ('PROVISIONAL','ACTIVE','COMPLETED','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  assignment_engine text NOT NULL CHECK (assignment_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  assignment_version text NOT NULL CHECK (assignment_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  assignment_trace jsonb NOT NULL CHECK (jsonb_typeof(assignment_trace)='object'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_by text,
  activated_at timestamptz,
  CHECK (ends_on IS NULL OR ends_on>=starts_on),
  CHECK ((status='PROVISIONAL' AND activated_by IS NULL AND activated_at IS NULL)
    OR (status<>'PROVISIONAL' AND activated_by IS NOT NULL AND activated_at IS NOT NULL)),
  EXCLUDE USING gist (student_id WITH =,
    daterange(starts_on,COALESCE(ends_on,'infinity'::date),'[]') WITH &&)
    WHERE (status<>'WITHDRAWN')
);
CREATE INDEX programme_enrolments_student_idx
  ON student.programme_enrolments(student_id,starts_on DESC);

CREATE OR REPLACE FUNCTION curriculum.protect_published_programme()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'DRAFT' AND (TG_OP='DELETE' OR
    to_jsonb(NEW)-ARRAY['status','record_version']<>to_jsonb(OLD)-ARRAY['status','record_version'])
    THEN RAISE EXCEPTION 'published programme version is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER programme_versions_immutable BEFORE UPDATE OR DELETE ON curriculum.programme_versions
FOR EACH ROW EXECUTE FUNCTION curriculum.protect_published_programme();

CREATE OR REPLACE FUNCTION student.protect_programme_assignment_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.student_id<>OLD.student_id
    OR NEW.programme_version_id<>OLD.programme_version_id OR NEW.starts_on<>OLD.starts_on
    OR NEW.ends_on IS DISTINCT FROM OLD.ends_on OR NEW.assignment_engine<>OLD.assignment_engine
    OR NEW.assignment_version<>OLD.assignment_version OR NEW.assignment_trace<>OLD.assignment_trace
    OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id OR NEW.assigned_by<>OLD.assigned_by
    OR NEW.assigned_at<>OLD.assigned_at THEN RAISE EXCEPTION 'programme assignment evidence is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER programme_enrolments_evidence_guard BEFORE UPDATE OR DELETE ON student.programme_enrolments
FOR EACH ROW EXECUTE FUNCTION student.protect_programme_assignment_evidence();
