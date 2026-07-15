CREATE TABLE admissions.merit_lists (
  id uuid PRIMARY KEY,
  list_key text NOT NULL CHECK (list_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  programme_key text NOT NULL CHECK (programme_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  cycle_key text NOT NULL CHECK (cycle_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  source_evidence_reference text NOT NULL CHECK (char_length(source_evidence_reference) BETWEEN 3 AND 300),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 1 AND 10000),
  entry_manifest_sha256 char(64) NOT NULL CHECK (entry_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  publication_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (list_key,version),
  CHECK ((status='DRAFT' AND publication_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status='PUBLISHED' AND char_length(publication_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND created_by<>published_by))
);

CREATE TABLE admissions.merit_list_entries (
  id uuid PRIMARY KEY,
  list_id uuid NOT NULL REFERENCES admissions.merit_lists(id),
  application_id uuid NOT NULL REFERENCES admissions.applications(id),
  merit_rank integer NOT NULL CHECK (merit_rank>0),
  allocation_order integer NOT NULL CHECK (allocation_order>0),
  category_key text NOT NULL CHECK (category_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  score_display text NOT NULL CHECK (char_length(score_display) BETWEEN 1 AND 100),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  UNIQUE (list_id,application_id),
  UNIQUE (list_id,allocation_order)
);

CREATE TABLE admissions.merit_entry_seat_reservations (
  merit_entry_id uuid PRIMARY KEY REFERENCES admissions.merit_list_entries(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES admissions.seat_reservations(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION admissions.assert_draft_merit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merit_list admissions.merit_lists%ROWTYPE; application admissions.applications%ROWTYPE;
BEGIN
  SELECT * INTO merit_list FROM admissions.merit_lists WHERE id=NEW.list_id FOR SHARE;
  SELECT * INTO application FROM admissions.applications WHERE id=NEW.application_id FOR SHARE;
  IF merit_list.id IS NULL OR merit_list.status<>'DRAFT' OR application.id IS NULL
    OR application.status NOT IN ('SUBMITTED','OFFERED')
    OR application.programme_key<>merit_list.programme_key
    OR application.scope_type<>merit_list.scope_type OR application.scope_id<>merit_list.scope_id THEN
    RAISE EXCEPTION 'invalid merit list entry';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_merit_entry_consistency BEFORE INSERT ON admissions.merit_list_entries
FOR EACH ROW EXECUTE FUNCTION admissions.assert_draft_merit_entry();
CREATE TRIGGER admission_merit_entries_no_mutation BEFORE UPDATE OR DELETE ON admissions.merit_list_entries
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_merit_list() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count integer; actual_manifest text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'merit list evidence is append-only'; END IF;
  SELECT count(*)::int,encode(digest(COALESCE(string_agg(
      octet_length(application_id::text)::text || ':' || application_id::text
      || octet_length(merit_rank::text)::text || ':' || merit_rank::text
      || octet_length(allocation_order::text)::text || ':' || allocation_order::text
      || octet_length(category_key)::text || ':' || category_key
      || octet_length(score_display)::text || ':' || score_display
      || octet_length(evaluation_trace::text)::text || ':' || evaluation_trace::text
      || octet_length(reason)::text || ':' || reason,
      '' ORDER BY allocation_order),''),'sha256'),'hex')
    INTO actual_count,actual_manifest FROM admissions.merit_list_entries WHERE list_id=OLD.id;
  IF OLD.status='DRAFT' AND NEW.status='DRAFT' AND OLD.entry_manifest_sha256=repeat('0',64)
    AND NEW.entry_manifest_sha256=actual_manifest AND actual_count=OLD.entry_count
    AND NEW.id=OLD.id AND NEW.list_key=OLD.list_key AND NEW.version=OLD.version AND NEW.title=OLD.title
    AND NEW.programme_key=OLD.programme_key AND NEW.cycle_key=OLD.cycle_key
    AND NEW.scope_type=OLD.scope_type AND NEW.scope_id=OLD.scope_id
    AND NEW.idempotency_key=OLD.idempotency_key AND NEW.evaluation_engine=OLD.evaluation_engine
    AND NEW.evaluation_version=OLD.evaluation_version AND NEW.policy_reference=OLD.policy_reference
    AND NEW.source_evidence_reference=OLD.source_evidence_reference AND NEW.entry_count=OLD.entry_count
    AND NEW.record_version=OLD.record_version AND NEW.publication_reference IS NULL
    AND NEW.created_by=OLD.created_by AND NEW.created_at=OLD.created_at
    AND NEW.published_by IS NULL AND NEW.published_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
    OR NEW.list_key<>OLD.list_key OR NEW.version<>OLD.version OR NEW.title<>OLD.title
    OR NEW.programme_key<>OLD.programme_key OR NEW.cycle_key<>OLD.cycle_key
    OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.evaluation_engine<>OLD.evaluation_engine
    OR NEW.evaluation_version<>OLD.evaluation_version OR NEW.policy_reference<>OLD.policy_reference
    OR NEW.source_evidence_reference<>OLD.source_evidence_reference OR NEW.entry_count<>OLD.entry_count
    OR NEW.entry_manifest_sha256<>OLD.entry_manifest_sha256 OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at OR NEW.published_by=OLD.created_by THEN
    RAISE EXCEPTION 'invalid merit list publication';
  END IF;
  IF actual_count<>OLD.entry_count OR actual_manifest<>OLD.entry_manifest_sha256 THEN
    RAISE EXCEPTION 'merit entries do not match their declared list';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_merit_list_guard BEFORE UPDATE OR DELETE ON admissions.merit_lists
FOR EACH ROW EXECUTE FUNCTION admissions.protect_merit_list();

CREATE OR REPLACE FUNCTION admissions.assert_merit_seat_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry admissions.merit_list_entries%ROWTYPE; merit_list admissions.merit_lists%ROWTYPE;
  reservation admissions.seat_reservations%ROWTYPE; matrix admissions.seat_matrices%ROWTYPE;
  category admissions.seat_categories%ROWTYPE;
BEGIN
  SELECT * INTO entry FROM admissions.merit_list_entries WHERE id=NEW.merit_entry_id FOR SHARE;
  SELECT * INTO merit_list FROM admissions.merit_lists WHERE id=entry.list_id FOR SHARE;
  SELECT * INTO reservation FROM admissions.seat_reservations WHERE id=NEW.reservation_id FOR SHARE;
  SELECT * INTO matrix FROM admissions.seat_matrices WHERE id=reservation.matrix_id FOR SHARE;
  SELECT * INTO category FROM admissions.seat_categories WHERE id=reservation.category_id FOR SHARE;
  IF entry.id IS NULL OR merit_list.id IS NULL OR merit_list.status<>'PUBLISHED'
    OR reservation.id IS NULL OR reservation.status<>'RESERVED' OR matrix.id IS NULL OR category.id IS NULL
    OR entry.application_id<>reservation.application_id OR entry.category_key<>category.category_key
    OR merit_list.programme_key<>matrix.programme_key OR merit_list.cycle_key<>matrix.cycle_key
    OR merit_list.scope_type<>matrix.scope_type OR merit_list.scope_id<>matrix.scope_id THEN
    RAISE EXCEPTION 'invalid merit entry seat reservation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_merit_seat_link_consistency BEFORE INSERT ON admissions.merit_entry_seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.assert_merit_seat_link();
CREATE TRIGGER admission_merit_seat_links_no_mutation BEFORE UPDATE OR DELETE ON admissions.merit_entry_seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
