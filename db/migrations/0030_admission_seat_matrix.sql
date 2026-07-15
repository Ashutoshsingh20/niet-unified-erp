CREATE TABLE admissions.seat_matrices (
  id uuid PRIMARY KEY,
  matrix_key text NOT NULL CHECK (matrix_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  programme_key text NOT NULL CHECK (programme_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  cycle_key text NOT NULL CHECK (cycle_key ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  category_count integer NOT NULL CHECK (category_count BETWEEN 1 AND 100),
  category_manifest_sha256 char(64) NOT NULL CHECK (category_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  policy_decision_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (matrix_key,version),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status='PUBLISHED' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND created_by<>published_by))
);
CREATE TABLE admissions.seat_categories (
  id uuid PRIMARY KEY,
  matrix_id uuid NOT NULL REFERENCES admissions.seat_matrices(id),
  category_key text NOT NULL CHECK (category_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  allocation_order integer NOT NULL CHECK (allocation_order>0),
  UNIQUE (matrix_id,category_key), UNIQUE (matrix_id,allocation_order)
);
CREATE TABLE admissions.seat_slots (
  id uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES admissions.seat_categories(id),
  slot_number integer NOT NULL CHECK (slot_number>0),
  UNIQUE (category_id,slot_number)
);
CREATE TABLE admissions.seat_reservations (
  id uuid PRIMARY KEY,
  matrix_id uuid NOT NULL REFERENCES admissions.seat_matrices(id),
  category_id uuid NOT NULL REFERENCES admissions.seat_categories(id),
  slot_id uuid NOT NULL REFERENCES admissions.seat_slots(id),
  application_id uuid NOT NULL REFERENCES admissions.applications(id),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','RELEASED','CONVERTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  reserved_by text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX admission_occupied_seat_slot ON admissions.seat_reservations(slot_id)
  WHERE status IN ('RESERVED','CONVERTED');
CREATE UNIQUE INDEX admission_occupied_application_seat ON admissions.seat_reservations(application_id)
  WHERE status IN ('RESERVED','CONVERTED');
CREATE TABLE admissions.offer_seat_reservations (
  offer_id uuid PRIMARY KEY REFERENCES admissions.offers(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES admissions.seat_reservations(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admissions.seat_releases (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL UNIQUE REFERENCES admissions.seat_reservations(id),
  offer_id uuid NOT NULL UNIQUE REFERENCES admissions.offers(id),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  released_by text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admissions.seat_conversions (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL UNIQUE REFERENCES admissions.seat_reservations(id),
  conversion_id uuid NOT NULL UNIQUE REFERENCES admissions.conversions(id),
  consumed_by text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION admissions.protect_seat_matrix() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count integer; actual_manifest text; slot_mismatch integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'seat matrix evidence is append-only'; END IF;
  IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
    OR NEW.matrix_key<>OLD.matrix_key OR NEW.version<>OLD.version OR NEW.title<>OLD.title
    OR NEW.programme_key<>OLD.programme_key OR NEW.cycle_key<>OLD.cycle_key
    OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.category_count<>OLD.category_count
    OR NEW.category_manifest_sha256<>OLD.category_manifest_sha256 OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at OR NEW.published_by=OLD.created_by THEN
    RAISE EXCEPTION 'invalid seat matrix publication';
  END IF;
  SELECT count(*)::int,encode(digest(COALESCE(string_agg(
      octet_length(category_key)::text || ':' || category_key
      || octet_length(title)::text || ':' || title
      || octet_length(capacity::text)::text || ':' || capacity::text
      || octet_length(allocation_order::text)::text || ':' || allocation_order::text,
      '' ORDER BY allocation_order),''),'sha256'),'hex')
    INTO actual_count,actual_manifest FROM admissions.seat_categories WHERE matrix_id=OLD.id;
  SELECT count(*)::int INTO slot_mismatch FROM admissions.seat_categories c
    WHERE c.matrix_id=OLD.id AND (SELECT count(*) FROM admissions.seat_slots s WHERE s.category_id=c.id)<>c.capacity;
  IF actual_count<>OLD.category_count OR actual_manifest<>OLD.category_manifest_sha256 OR slot_mismatch<>0 THEN
    RAISE EXCEPTION 'seat categories or slots do not match their declared matrix';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_seat_matrix_guard BEFORE UPDATE OR DELETE ON admissions.seat_matrices
FOR EACH ROW EXECUTE FUNCTION admissions.protect_seat_matrix();
CREATE OR REPLACE FUNCTION admissions.assert_draft_seat_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matrix_id uuid;
BEGIN
  IF TG_TABLE_NAME='seat_categories' THEN
    matrix_id := NEW.matrix_id;
  ELSE
    SELECT c.matrix_id INTO matrix_id FROM admissions.seat_categories c WHERE c.id=NEW.category_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM admissions.seat_matrices WHERE id=matrix_id AND status='DRAFT') THEN
    RAISE EXCEPTION 'seat matrix children require a draft matrix';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_seat_category_draft_guard BEFORE INSERT ON admissions.seat_categories
FOR EACH ROW EXECUTE FUNCTION admissions.assert_draft_seat_child();
CREATE TRIGGER admission_seat_slot_draft_guard BEFORE INSERT ON admissions.seat_slots
FOR EACH ROW EXECUTE FUNCTION admissions.assert_draft_seat_child();
CREATE TRIGGER admission_seat_categories_no_mutation BEFORE UPDATE OR DELETE ON admissions.seat_categories
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_seat_slots_no_mutation BEFORE UPDATE OR DELETE ON admissions.seat_slots
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.assert_seat_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matrix admissions.seat_matrices%ROWTYPE; category admissions.seat_categories%ROWTYPE;
  application admissions.applications%ROWTYPE; slot admissions.seat_slots%ROWTYPE;
BEGIN
  SELECT * INTO matrix FROM admissions.seat_matrices WHERE id=NEW.matrix_id FOR SHARE;
  SELECT * INTO category FROM admissions.seat_categories WHERE id=NEW.category_id FOR SHARE;
  SELECT * INTO slot FROM admissions.seat_slots WHERE id=NEW.slot_id FOR SHARE;
  SELECT * INTO application FROM admissions.applications WHERE id=NEW.application_id FOR SHARE;
  IF matrix.id IS NULL OR matrix.status<>'PUBLISHED' OR category.matrix_id<>matrix.id
    OR slot.category_id<>category.id OR application.id IS NULL OR application.status<>'OFFERED'
    OR application.programme_key<>matrix.programme_key OR application.scope_type<>matrix.scope_type
    OR application.scope_id<>matrix.scope_id THEN RAISE EXCEPTION 'invalid seat reservation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_seat_reservation_consistency BEFORE INSERT ON admissions.seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.assert_seat_reservation();
CREATE OR REPLACE FUNCTION admissions.protect_seat_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'seat reservation evidence is append-only'; END IF;
  IF OLD.status<>'RESERVED' OR NEW.version<>OLD.version+1
    OR NEW.matrix_id<>OLD.matrix_id OR NEW.category_id<>OLD.category_id OR NEW.slot_id<>OLD.slot_id
    OR NEW.application_id<>OLD.application_id OR NEW.idempotency_key<>OLD.idempotency_key
    OR NEW.evaluation_engine<>OLD.evaluation_engine OR NEW.evaluation_version<>OLD.evaluation_version
    OR NEW.policy_reference<>OLD.policy_reference OR NEW.evaluation_trace<>OLD.evaluation_trace
    OR NEW.reason<>OLD.reason OR NEW.reserved_by<>OLD.reserved_by OR NEW.reserved_at<>OLD.reserved_at
    OR (NEW.status='RELEASED' AND NOT EXISTS (SELECT 1 FROM admissions.seat_releases WHERE reservation_id=OLD.id))
    OR (NEW.status='CONVERTED' AND NOT EXISTS (SELECT 1 FROM admissions.seat_conversions WHERE reservation_id=OLD.id))
    OR NEW.status NOT IN ('RELEASED','CONVERTED') THEN RAISE EXCEPTION 'invalid seat reservation transition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_seat_reservation_guard BEFORE UPDATE OR DELETE ON admissions.seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.protect_seat_reservation();

CREATE OR REPLACE FUNCTION admissions.assert_offer_seat_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer admissions.offers%ROWTYPE; reservation admissions.seat_reservations%ROWTYPE;
BEGIN
  SELECT * INTO offer FROM admissions.offers WHERE id=NEW.offer_id FOR SHARE;
  SELECT * INTO reservation FROM admissions.seat_reservations WHERE id=NEW.reservation_id FOR SHARE;
  IF offer.id IS NULL OR reservation.id IS NULL OR reservation.status<>'RESERVED'
    OR offer.application_id<>reservation.application_id THEN RAISE EXCEPTION 'invalid offer seat reservation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_offer_seat_link_consistency BEFORE INSERT ON admissions.offer_seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.assert_offer_seat_link();
CREATE TRIGGER admission_offer_seat_links_no_mutation BEFORE UPDATE OR DELETE ON admissions.offer_seat_reservations
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.assert_seat_terminal_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation admissions.seat_reservations%ROWTYPE; offer admissions.offers%ROWTYPE;
  conversion admissions.conversions%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM admissions.seat_reservations WHERE id=NEW.reservation_id FOR SHARE;
  IF TG_TABLE_NAME='seat_releases' THEN
    SELECT * INTO offer FROM admissions.offers WHERE id=NEW.offer_id FOR SHARE;
    IF reservation.id IS NULL OR reservation.status<>'RESERVED' OR offer.id IS NULL
      OR offer.status NOT IN ('DECLINED','WITHDRAWN','EXPIRED','CANCELLED')
      OR NOT EXISTS (SELECT 1 FROM admissions.offer_seat_reservations
        WHERE offer_id=offer.id AND reservation_id=reservation.id) THEN
      RAISE EXCEPTION 'invalid seat release evidence'; END IF;
  ELSE
    SELECT * INTO conversion FROM admissions.conversions WHERE id=NEW.conversion_id FOR SHARE;
    IF reservation.id IS NULL OR reservation.status<>'RESERVED' OR conversion.id IS NULL
      OR conversion.application_id<>reservation.application_id OR conversion.converted_by<>NEW.consumed_by
      OR NOT EXISTS (SELECT 1 FROM admissions.offer_seat_reservations osr
        WHERE osr.reservation_id=reservation.id AND osr.offer_id=conversion.offer_id) THEN
      RAISE EXCEPTION 'invalid seat conversion evidence'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_seat_release_consistency BEFORE INSERT ON admissions.seat_releases
FOR EACH ROW EXECUTE FUNCTION admissions.assert_seat_terminal_evidence();
CREATE TRIGGER admission_seat_conversion_consistency BEFORE INSERT ON admissions.seat_conversions
FOR EACH ROW EXECUTE FUNCTION admissions.assert_seat_terminal_evidence();
CREATE TRIGGER admission_seat_releases_no_mutation BEFORE UPDATE OR DELETE ON admissions.seat_releases
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_seat_conversions_no_mutation BEFORE UPDATE OR DELETE ON admissions.seat_conversions
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
