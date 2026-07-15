CREATE TABLE registration.capacity_pools (
  id uuid PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  pool_key text NOT NULL CHECK (pool_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  capacity integer NOT NULL CHECK (capacity>0),
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
  UNIQUE (offering_id,pool_key,version),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status<>'DRAFT' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND published_by<>created_by))
);
CREATE UNIQUE INDEX registration_one_published_capacity_pool_version
  ON registration.capacity_pools(offering_id,pool_key) WHERE status='PUBLISHED';

CREATE TABLE registration.capacity_entitlements (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  pool_id uuid NOT NULL REFERENCES registration.capacity_pools(id),
  idempotency_key uuid NOT NULL UNIQUE,
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','REJECTED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  CHECK ((status='DRAFT' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status<>'DRAFT' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by<>requested_by))
);

CREATE TABLE registration.request_capacity_assignments (
  request_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  pool_id uuid NOT NULL REFERENCES registration.capacity_pools(id),
  entitlement_id uuid NOT NULL REFERENCES registration.capacity_entitlements(id),
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id,offering_id),
  UNIQUE (request_id,entitlement_id),
  FOREIGN KEY (request_id,offering_id) REFERENCES registration.request_items(request_id,offering_id)
);

CREATE TABLE registration.confirmed_item_allocations (
  request_id uuid NOT NULL REFERENCES registration.requests(id),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  pool_id uuid REFERENCES registration.capacity_pools(id),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id,offering_id),
  UNIQUE (student_id,offering_id)
);
CREATE INDEX registration_confirmed_pool_capacity_idx
  ON registration.confirmed_item_allocations(offering_id,pool_id);

INSERT INTO registration.confirmed_item_allocations(request_id,offering_id,student_id,confirmed_at)
SELECT i.request_id,i.offering_id,r.student_id,COALESCE(r.decided_at,r.submitted_at)
FROM registration.request_items i JOIN registration.requests r ON r.id=i.request_id
WHERE r.status='CONFIRMED';

CREATE OR REPLACE FUNCTION registration.assert_capacity_pool() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offering registration.offerings%ROWTYPE; reserved_total integer;
BEGIN
  SELECT * INTO offering FROM registration.offerings WHERE id=NEW.offering_id FOR SHARE;
  IF offering.id IS NULL OR offering.status<>'PUBLISHED' OR offering.scope_type<>NEW.scope_type
    OR offering.scope_id<>NEW.scope_id THEN RAISE EXCEPTION 'invalid registration capacity pool'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
      OR to_jsonb(NEW)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
        <>to_jsonb(OLD)-ARRAY['status','record_version','policy_decision_reference','published_by','published_at']
      THEN RAISE EXCEPTION 'invalid registration capacity pool publication'; END IF;
    SELECT COALESCE(sum(capacity),0)::int INTO reserved_total FROM registration.capacity_pools
      WHERE offering_id=NEW.offering_id AND status='PUBLISHED' AND id<>NEW.id;
    IF reserved_total+NEW.capacity>offering.capacity THEN
      RAISE EXCEPTION 'published reserved capacity exceeds offering capacity'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_capacity_pool_consistency BEFORE INSERT OR UPDATE
ON registration.capacity_pools FOR EACH ROW EXECUTE FUNCTION registration.assert_capacity_pool();
CREATE TRIGGER registration_capacity_pools_no_delete BEFORE DELETE ON registration.capacity_pools
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_capacity_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE student student.records%ROWTYPE; pool registration.capacity_pools%ROWTYPE;
BEGIN
  SELECT * INTO student FROM student.records WHERE id=NEW.student_id FOR SHARE;
  SELECT * INTO pool FROM registration.capacity_pools WHERE id=NEW.pool_id FOR SHARE;
  IF student.id IS NULL OR pool.id IS NULL OR pool.status<>'PUBLISHED'
    OR student.scope_type<>NEW.scope_type OR student.scope_id<>NEW.scope_id
    OR pool.scope_type<>NEW.scope_type OR pool.scope_id<>NEW.scope_id
    THEN RAISE EXCEPTION 'invalid registration capacity entitlement'; END IF;
  IF TG_OP='UPDATE' AND (OLD.status<>'DRAFT' OR NEW.status NOT IN ('APPROVED','REJECTED')
    OR NEW.record_version<>OLD.record_version+1
    OR to_jsonb(NEW)-ARRAY['status','record_version','decided_by','decided_at']
      <>to_jsonb(OLD)-ARRAY['status','record_version','decided_by','decided_at'])
    THEN RAISE EXCEPTION 'invalid registration capacity entitlement decision'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_capacity_entitlement_consistency BEFORE INSERT OR UPDATE
ON registration.capacity_entitlements FOR EACH ROW EXECUTE FUNCTION registration.assert_capacity_entitlement();
CREATE TRIGGER registration_capacity_entitlements_no_delete BEFORE DELETE ON registration.capacity_entitlements
FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_request_capacity_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; pool registration.capacity_pools%ROWTYPE;
  entitlement registration.capacity_entitlements%ROWTYPE;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO pool FROM registration.capacity_pools WHERE id=NEW.pool_id FOR SHARE;
  SELECT * INTO entitlement FROM registration.capacity_entitlements WHERE id=NEW.entitlement_id FOR SHARE;
  IF request.id IS NULL OR request.status<>'PENDING' OR request.submitted_by<>NEW.assigned_by
    OR pool.id IS NULL OR pool.status<>'PUBLISHED' OR pool.offering_id<>NEW.offering_id
    OR entitlement.id IS NULL OR entitlement.status<>'APPROVED' OR entitlement.pool_id<>pool.id
    OR entitlement.student_id<>request.student_id OR entitlement.scope_type<>request.scope_type
    OR entitlement.scope_id<>request.scope_id THEN RAISE EXCEPTION 'invalid request capacity assignment'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_request_capacity_assignment_consistency BEFORE INSERT
ON registration.request_capacity_assignments FOR EACH ROW
EXECUTE FUNCTION registration.assert_request_capacity_assignment();
CREATE TRIGGER registration_request_capacity_assignments_no_mutation BEFORE UPDATE OR DELETE
ON registration.request_capacity_assignments FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_confirmed_item_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; assignment registration.request_capacity_assignments%ROWTYPE;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO assignment FROM registration.request_capacity_assignments
    WHERE request_id=NEW.request_id AND offering_id=NEW.offering_id;
  IF request.id IS NULL OR request.status<>'CONFIRMED' OR request.student_id<>NEW.student_id
    OR NOT EXISTS (SELECT 1 FROM registration.request_items
      WHERE request_id=NEW.request_id AND offering_id=NEW.offering_id)
    OR NEW.pool_id IS DISTINCT FROM assignment.pool_id
    THEN RAISE EXCEPTION 'invalid confirmed registration allocation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_confirmed_item_allocation_consistency BEFORE INSERT
ON registration.confirmed_item_allocations FOR EACH ROW
EXECUTE FUNCTION registration.assert_confirmed_item_allocation();
