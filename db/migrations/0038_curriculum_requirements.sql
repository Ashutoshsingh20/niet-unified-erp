CREATE TABLE curriculum.course_catalogues (
  id uuid PRIMARY KEY,
  catalogue_key text NOT NULL CHECK (catalogue_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  regulation_id uuid NOT NULL REFERENCES curriculum.regulation_versions(id),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  entry_manifest_sha256 char(64) NOT NULL CHECK (entry_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  policy_decision_reference text,
  published_by text,
  published_at timestamptz,
  UNIQUE (catalogue_key,version),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status<>'DRAFT' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND published_by<>created_by))
);

CREATE TABLE curriculum.course_catalogue_entries (
  catalogue_id uuid NOT NULL REFERENCES curriculum.course_catalogues(id),
  course_key text NOT NULL CHECK (course_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  credit_units numeric(8,2) NOT NULL CHECK (credit_units>=0),
  attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes)='object'),
  PRIMARY KEY (catalogue_id,course_key)
);

CREATE TABLE curriculum.requirement_sets (
  id uuid PRIMARY KEY,
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  requirement_type text NOT NULL CHECK (requirement_type IN ('COURSE_ELIGIBILITY','DEGREE_AUDIT')),
  programme_version_id uuid NOT NULL REFERENCES curriculum.programme_versions(id),
  catalogue_id uuid NOT NULL REFERENCES curriculum.course_catalogues(id),
  target_course_key text,
  evaluation_contract_version text NOT NULL CHECK (evaluation_contract_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  clause_manifest_sha256 char(64) NOT NULL CHECK (clause_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  policy_decision_reference text,
  published_by text,
  published_at timestamptz,
  UNIQUE (requirement_key,version),
  CHECK ((requirement_type='COURSE_ELIGIBILITY' AND target_course_key IS NOT NULL
      AND target_course_key ~ '^[a-zA-Z0-9_.-]{2,100}$')
    OR (requirement_type='DEGREE_AUDIT' AND target_course_key IS NULL)),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status<>'DRAFT' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND published_by<>created_by))
);

CREATE TABLE curriculum.requirement_clauses (
  requirement_set_id uuid NOT NULL REFERENCES curriculum.requirement_sets(id),
  clause_key text NOT NULL CHECK (clause_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  sequence integer NOT NULL CHECK (sequence>0),
  clause_type text NOT NULL CHECK (clause_type IN ('COURSE_COMPLETION','MINIMUM_GRADE',
    'MINIMUM_CREDITS','COREQUISITE','BASKET','EQUIVALENCE','TRANSFER','RPL','MOOC',
    'ABC_APAAR','CUSTOM')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  rule_document jsonb NOT NULL CHECK (jsonb_typeof(rule_document)='object'),
  PRIMARY KEY (requirement_set_id,clause_key),
  UNIQUE (requirement_set_id,sequence)
);

CREATE TABLE curriculum.requirement_evaluations (
  id uuid PRIMARY KEY,
  requirement_set_id uuid NOT NULL REFERENCES curriculum.requirement_sets(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  evaluation_mode text NOT NULL CHECK (evaluation_mode IN ('REGISTRATION','DEGREE_AUDIT','WHAT_IF')),
  candidate_manifest_sha256 char(64) NOT NULL CHECK (candidate_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_evidence_manifest_sha256 char(64) NOT NULL CHECK (source_evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result IN ('ELIGIBLE','INELIGIBLE','INCOMPLETE')),
  result_manifest_sha256 char(64) NOT NULL CHECK (result_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evaluator_engine text NOT NULL CHECK (evaluator_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluator_version text NOT NULL CHECK (evaluator_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  explanation_summary text NOT NULL CHECK (char_length(explanation_summary) BETWEEN 3 AND 2000),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  evaluated_by text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX curriculum_requirement_evaluations_student_idx
  ON curriculum.requirement_evaluations(student_id,evaluated_at DESC);

CREATE TABLE curriculum.requirement_evaluation_results (
  evaluation_id uuid NOT NULL REFERENCES curriculum.requirement_evaluations(id),
  clause_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SATISFIED','UNSATISFIED','UNKNOWN','NOT_APPLICABLE')),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 3 AND 1000),
  evidence_trace jsonb NOT NULL CHECK (jsonb_typeof(evidence_trace)='object'),
  PRIMARY KEY (evaluation_id,clause_key)
);

CREATE OR REPLACE FUNCTION curriculum.assert_course_catalogue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE regulation curriculum.regulation_versions%ROWTYPE; actual_manifest text;
BEGIN
  SELECT * INTO regulation FROM curriculum.regulation_versions WHERE id=NEW.regulation_id FOR SHARE;
  IF regulation.id IS NULL OR regulation.status<>'PUBLISHED' OR regulation.scope_type<>NEW.scope_type
    OR regulation.scope_id<>NEW.scope_id THEN RAISE EXCEPTION 'invalid course catalogue regulation'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.status='DRAFT' THEN
      IF OLD.status<>'DRAFT' OR to_jsonb(NEW)-'entry_manifest_sha256'
        <>to_jsonb(OLD)-'entry_manifest_sha256' THEN RAISE EXCEPTION 'invalid course catalogue draft'; END IF;
      RETURN NEW;
    END IF;
    IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
      OR to_jsonb(NEW)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
        <>to_jsonb(OLD)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
      THEN RAISE EXCEPTION 'invalid course catalogue publication'; END IF;
    SELECT encode(digest(COALESCE(string_agg(jsonb_build_object('courseKey',course_key,'title',title,
      'creditUnits',credit_units::text,'attributes',attributes)::text,',' ORDER BY course_key),''),
      'sha256'),'hex') INTO actual_manifest FROM curriculum.course_catalogue_entries
      WHERE catalogue_id=NEW.id;
    IF actual_manifest<>NEW.entry_manifest_sha256 OR NOT EXISTS
      (SELECT 1 FROM curriculum.course_catalogue_entries WHERE catalogue_id=NEW.id)
      THEN RAISE EXCEPTION 'course catalogue entry manifest mismatch'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_course_catalogue_consistency BEFORE INSERT OR UPDATE
ON curriculum.course_catalogues FOR EACH ROW EXECUTE FUNCTION curriculum.assert_course_catalogue();

CREATE OR REPLACE FUNCTION curriculum.assert_requirement_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE programme curriculum.programme_versions%ROWTYPE; catalogue curriculum.course_catalogues%ROWTYPE;
  actual_manifest text;
BEGIN
  SELECT * INTO programme FROM curriculum.programme_versions WHERE id=NEW.programme_version_id FOR SHARE;
  SELECT * INTO catalogue FROM curriculum.course_catalogues WHERE id=NEW.catalogue_id FOR SHARE;
  IF programme.id IS NULL OR programme.status<>'PUBLISHED' OR catalogue.id IS NULL
    OR catalogue.status<>'PUBLISHED' OR programme.scope_type<>NEW.scope_type
    OR programme.scope_id<>NEW.scope_id OR catalogue.scope_type<>NEW.scope_type
    OR catalogue.scope_id<>NEW.scope_id OR (NEW.target_course_key IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM curriculum.course_catalogue_entries WHERE catalogue_id=NEW.catalogue_id
        AND course_key=NEW.target_course_key))
    THEN RAISE EXCEPTION 'invalid curriculum requirement set'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.status='DRAFT' THEN
      IF OLD.status<>'DRAFT' OR to_jsonb(NEW)-'clause_manifest_sha256'
        <>to_jsonb(OLD)-'clause_manifest_sha256' THEN RAISE EXCEPTION 'invalid requirement set draft'; END IF;
      RETURN NEW;
    END IF;
    IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
      OR to_jsonb(NEW)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
        <>to_jsonb(OLD)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
      THEN RAISE EXCEPTION 'invalid requirement set publication'; END IF;
    SELECT encode(digest(COALESCE(string_agg(jsonb_build_object('clauseKey',clause_key,'sequence',sequence,
      'clauseType',clause_type,'title',title,'ruleDocument',rule_document)::text,',' ORDER BY sequence),''),
      'sha256'),'hex') INTO actual_manifest FROM curriculum.requirement_clauses
      WHERE requirement_set_id=NEW.id;
    IF actual_manifest<>NEW.clause_manifest_sha256 OR NOT EXISTS
      (SELECT 1 FROM curriculum.requirement_clauses WHERE requirement_set_id=NEW.id)
      THEN RAISE EXCEPTION 'requirement clause manifest mismatch'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_requirement_set_consistency BEFORE INSERT OR UPDATE
ON curriculum.requirement_sets FOR EACH ROW EXECUTE FUNCTION curriculum.assert_requirement_set();

CREATE OR REPLACE FUNCTION curriculum.protect_curriculum_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'DRAFT' THEN
    RAISE EXCEPTION 'published curriculum configuration is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_course_catalogues_no_delete BEFORE DELETE
ON curriculum.course_catalogues FOR EACH ROW EXECUTE FUNCTION curriculum.protect_curriculum_configuration();
CREATE TRIGGER curriculum_requirement_sets_no_delete BEFORE DELETE
ON curriculum.requirement_sets FOR EACH ROW EXECUTE FUNCTION curriculum.protect_curriculum_configuration();

CREATE OR REPLACE FUNCTION curriculum.assert_catalogue_entry_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM curriculum.course_catalogues
    WHERE id=NEW.catalogue_id AND status='DRAFT')
    THEN RAISE EXCEPTION 'course catalogue entries require a draft catalogue'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_course_catalogue_entry_draft BEFORE INSERT
ON curriculum.course_catalogue_entries FOR EACH ROW EXECUTE FUNCTION curriculum.assert_catalogue_entry_draft();

CREATE OR REPLACE FUNCTION curriculum.assert_requirement_clause_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM curriculum.requirement_sets
    WHERE id=NEW.requirement_set_id AND status='DRAFT')
    THEN RAISE EXCEPTION 'requirement clauses require a draft requirement set'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_requirement_clause_draft BEFORE INSERT
ON curriculum.requirement_clauses FOR EACH ROW EXECUTE FUNCTION curriculum.assert_requirement_clause_draft();

CREATE TRIGGER curriculum_course_catalogue_entries_no_mutation BEFORE UPDATE OR DELETE
ON curriculum.course_catalogue_entries FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER curriculum_requirement_clauses_no_mutation BEFORE UPDATE OR DELETE
ON curriculum.requirement_clauses FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION curriculum.assert_requirement_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requirement curriculum.requirement_sets%ROWTYPE; student student.records%ROWTYPE;
BEGIN
  SELECT * INTO requirement FROM curriculum.requirement_sets WHERE id=NEW.requirement_set_id FOR SHARE;
  SELECT * INTO student FROM student.records WHERE id=NEW.student_id FOR SHARE;
  IF requirement.id IS NULL OR requirement.status<>'PUBLISHED' OR student.id IS NULL
    OR requirement.scope_type<>NEW.scope_type OR requirement.scope_id<>NEW.scope_id
    OR student.scope_type<>NEW.scope_type OR student.scope_id<>NEW.scope_id
    OR (requirement.requirement_type='COURSE_ELIGIBILITY' AND NEW.evaluation_mode<>'REGISTRATION')
    OR (requirement.requirement_type='DEGREE_AUDIT' AND NEW.evaluation_mode='REGISTRATION')
    THEN RAISE EXCEPTION 'invalid curriculum requirement evaluation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_requirement_evaluation_consistency BEFORE INSERT
ON curriculum.requirement_evaluations FOR EACH ROW
EXECUTE FUNCTION curriculum.assert_requirement_evaluation();

CREATE OR REPLACE FUNCTION curriculum.assert_requirement_evaluation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_evaluation curriculum.requirement_evaluations%ROWTYPE;
  actual_manifest text; expected_count integer; actual_count integer;
BEGIN
  SELECT * INTO current_evaluation FROM curriculum.requirement_evaluations WHERE id=NEW.id;
  SELECT count(*)::int INTO expected_count FROM curriculum.requirement_clauses
    WHERE requirement_set_id=current_evaluation.requirement_set_id;
  SELECT count(*)::int,encode(digest(COALESCE(string_agg(jsonb_build_object('clauseKey',r.clause_key,
    'outcome',r.outcome,'evidenceReference',r.evidence_reference,'explanation',r.explanation,
    'evidenceTrace',r.evidence_trace)::text,',' ORDER BY c.sequence),''),'sha256'),'hex')
    INTO actual_count,actual_manifest FROM curriculum.requirement_evaluation_results r
    JOIN curriculum.requirement_clauses c ON c.requirement_set_id=current_evaluation.requirement_set_id
      AND c.clause_key=r.clause_key WHERE r.evaluation_id=NEW.id;
  IF expected_count=0 OR actual_count<>expected_count
    OR actual_manifest<>current_evaluation.result_manifest_sha256
    OR EXISTS (SELECT 1 FROM curriculum.requirement_evaluation_results r
      WHERE r.evaluation_id=NEW.id AND NOT EXISTS (SELECT 1 FROM curriculum.requirement_clauses c
        WHERE c.requirement_set_id=current_evaluation.requirement_set_id AND c.clause_key=r.clause_key))
    THEN RAISE EXCEPTION 'incomplete curriculum requirement evaluation'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER curriculum_requirement_evaluation_complete_at_commit
AFTER INSERT ON curriculum.requirement_evaluations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION curriculum.assert_requirement_evaluation_complete();

CREATE OR REPLACE FUNCTION curriculum.assert_requirement_evaluation_result_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE evaluation curriculum.requirement_evaluations%ROWTYPE;
BEGIN
  SELECT * INTO evaluation FROM curriculum.requirement_evaluations WHERE id=NEW.evaluation_id FOR SHARE;
  IF evaluation.id IS NULL OR evaluation.result_manifest_sha256<>repeat('0',64)
    OR NOT EXISTS (SELECT 1 FROM curriculum.requirement_clauses
      WHERE requirement_set_id=evaluation.requirement_set_id AND clause_key=NEW.clause_key)
    THEN RAISE EXCEPTION 'invalid or sealed requirement evaluation result'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER curriculum_requirement_evaluation_result_consistency BEFORE INSERT
ON curriculum.requirement_evaluation_results FOR EACH ROW
EXECUTE FUNCTION curriculum.assert_requirement_evaluation_result_insert();

CREATE OR REPLACE FUNCTION curriculum.protect_requirement_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.result_manifest_sha256=repeat('0',64)
    AND NEW.result_manifest_sha256<>repeat('0',64)
    AND to_jsonb(NEW)-'result_manifest_sha256'=to_jsonb(OLD)-'result_manifest_sha256'
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'curriculum requirement evaluations are append-only';
END; $$;
CREATE TRIGGER curriculum_requirement_evaluations_no_mutation BEFORE UPDATE OR DELETE
ON curriculum.requirement_evaluations FOR EACH ROW EXECUTE FUNCTION curriculum.protect_requirement_evaluation();
CREATE TRIGGER curriculum_requirement_evaluation_results_no_mutation BEFORE UPDATE OR DELETE
ON curriculum.requirement_evaluation_results FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
