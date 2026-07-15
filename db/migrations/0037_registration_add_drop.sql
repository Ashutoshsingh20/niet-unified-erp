CREATE TABLE registration.add_drop_requests (
  id uuid PRIMARY KEY,
  registration_request_id uuid NOT NULL REFERENCES registration.requests(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  period_id uuid NOT NULL REFERENCES registration.academic_periods(id),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  before_manifest_sha256 char(64) NOT NULL CHECK (before_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  after_manifest_sha256 char(64) NOT NULL CHECK (after_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  before_item_count integer NOT NULL CHECK (before_item_count>0),
  after_item_count integer NOT NULL CHECK (after_item_count>0),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  CHECK (before_manifest_sha256<>after_manifest_sha256),
  CHECK ((status='PENDING' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status<>'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by<>requested_by AND char_length(decision_reason) BETWEEN 3 AND 1000))
);
CREATE INDEX registration_add_drop_base_request_idx
  ON registration.add_drop_requests(registration_request_id,requested_at DESC);
CREATE UNIQUE INDEX registration_one_pending_add_drop
  ON registration.add_drop_requests(registration_request_id) WHERE status='PENDING';

CREATE TABLE registration.add_drop_manifest_items (
  add_drop_request_id uuid NOT NULL REFERENCES registration.add_drop_requests(id),
  manifest_side text NOT NULL CHECK (manifest_side IN ('BEFORE','AFTER')),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  PRIMARY KEY (add_drop_request_id,manifest_side,offering_id)
);

CREATE TABLE registration.add_drop_override_usages (
  add_drop_request_id uuid NOT NULL REFERENCES registration.add_drop_requests(id),
  authorization_id uuid NOT NULL UNIQUE REFERENCES registration.override_authorizations(id),
  exception_type text NOT NULL CHECK (exception_type IN
    ('CREDIT_LIMIT','ADVISER_APPROVAL','TIMETABLE_CONFLICT','CAPACITY')),
  used_by text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (add_drop_request_id,exception_type)
);

CREATE TABLE registration.add_drop_capacity_assignments (
  add_drop_request_id uuid NOT NULL REFERENCES registration.add_drop_requests(id),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  pool_id uuid NOT NULL REFERENCES registration.capacity_pools(id),
  entitlement_id uuid NOT NULL REFERENCES registration.capacity_entitlements(id),
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (add_drop_request_id,offering_id),
  UNIQUE (add_drop_request_id,entitlement_id)
);

CREATE TABLE registration.add_drop_eligibility_snapshots (
  add_drop_request_id uuid PRIMARY KEY REFERENCES registration.add_drop_requests(id),
  requested_credit_units numeric(8,2) NOT NULL CHECK (requested_credit_units>=0),
  maximum_credit_units numeric(8,2) NOT NULL CHECK (maximum_credit_units>=0),
  adviser_required boolean NOT NULL,
  adviser_approval_id uuid REFERENCES registration.adviser_approvals(id),
  timetable_conflict_count integer NOT NULL CHECK (timetable_conflict_count>=0),
  timetable_manifest_sha256 char(64) NOT NULL CHECK (timetable_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL
);

CREATE TABLE registration.add_drop_decisions (
  id uuid PRIMARY KEY,
  add_drop_request_id uuid NOT NULL UNIQUE REFERENCES registration.add_drop_requests(id),
  outcome text NOT NULL CHECK (outcome IN ('APPROVED','REJECTED')),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE registration.confirmed_item_allocations
  ADD COLUMN add_drop_request_id uuid REFERENCES registration.add_drop_requests(id);

CREATE TABLE registration.add_drop_allocation_events (
  id uuid PRIMARY KEY,
  add_drop_request_id uuid NOT NULL REFERENCES registration.add_drop_requests(id),
  registration_request_id uuid NOT NULL REFERENCES registration.requests(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  offering_id uuid NOT NULL REFERENCES registration.offerings(id),
  action text NOT NULL CHECK (action IN ('ADD','DROP')),
  pool_id uuid REFERENCES registration.capacity_pools(id),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (add_drop_request_id,offering_id)
);

CREATE OR REPLACE FUNCTION registration.assert_add_drop_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base registration.requests%ROWTYPE;
BEGIN
  SELECT * INTO base FROM registration.requests WHERE id=NEW.registration_request_id FOR SHARE;
  IF base.id IS NULL OR base.status<>'CONFIRMED' OR base.student_id<>NEW.student_id
    OR base.period_id<>NEW.period_id OR base.scope_type<>NEW.scope_type OR base.scope_id<>NEW.scope_id
    THEN RAISE EXCEPTION 'invalid registration add/drop request'; END IF;
  IF TG_OP='UPDATE' AND (OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED')
    OR NEW.version<>OLD.version+1
    OR to_jsonb(NEW)-ARRAY['status','version','decided_by','decided_at','decision_reason']
      <>to_jsonb(OLD)-ARRAY['status','version','decided_by','decided_at','decision_reason'])
    THEN RAISE EXCEPTION 'invalid registration add/drop decision'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_request_consistency BEFORE INSERT OR UPDATE
ON registration.add_drop_requests FOR EACH ROW EXECUTE FUNCTION registration.assert_add_drop_request();
CREATE TRIGGER registration_add_drop_requests_no_delete BEFORE DELETE
ON registration.add_drop_requests FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_override_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change registration.add_drop_requests%ROWTYPE; auth registration.override_authorizations%ROWTYPE;
BEGIN
  SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
  SELECT * INTO auth FROM registration.override_authorizations WHERE id=NEW.authorization_id FOR UPDATE;
  IF change.id IS NULL OR change.status<>'PENDING' OR change.requested_by<>NEW.used_by
    OR auth.id IS NULL OR auth.status<>'APPROVED' OR auth.student_id<>change.student_id
    OR auth.period_id<>change.period_id OR auth.scope_type<>change.scope_type
    OR auth.scope_id<>change.scope_id OR auth.exception_type<>NEW.exception_type
    OR auth.offering_manifest_sha256<>change.after_manifest_sha256
    THEN RAISE EXCEPTION 'invalid add/drop override usage'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_override_usage_consistency BEFORE INSERT
ON registration.add_drop_override_usages FOR EACH ROW
EXECUTE FUNCTION registration.assert_add_drop_override_usage();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_capacity_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change registration.add_drop_requests%ROWTYPE; pool registration.capacity_pools%ROWTYPE;
  entitlement registration.capacity_entitlements%ROWTYPE;
BEGIN
  SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
  SELECT * INTO pool FROM registration.capacity_pools WHERE id=NEW.pool_id FOR SHARE;
  SELECT * INTO entitlement FROM registration.capacity_entitlements WHERE id=NEW.entitlement_id FOR SHARE;
  IF change.id IS NULL OR change.status<>'PENDING' OR change.requested_by<>NEW.assigned_by
    OR NOT EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
      WHERE add_drop_request_id=change.id AND manifest_side='AFTER' AND offering_id=NEW.offering_id)
    OR EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
      WHERE add_drop_request_id=change.id AND manifest_side='BEFORE' AND offering_id=NEW.offering_id)
    OR pool.id IS NULL OR pool.status<>'PUBLISHED' OR pool.offering_id<>NEW.offering_id
    OR entitlement.id IS NULL OR entitlement.status<>'APPROVED' OR entitlement.pool_id<>pool.id
    OR entitlement.student_id<>change.student_id OR entitlement.scope_type<>change.scope_type
    OR entitlement.scope_id<>change.scope_id
    THEN RAISE EXCEPTION 'invalid add/drop capacity assignment'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_capacity_assignment_consistency BEFORE INSERT
ON registration.add_drop_capacity_assignments FOR EACH ROW
EXECUTE FUNCTION registration.assert_add_drop_capacity_assignment();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_eligibility_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change registration.add_drop_requests%ROWTYPE; approval registration.adviser_approvals%ROWTYPE;
  actual_before text; actual_after text; actual_before_count integer; actual_after_count integer;
  credit_override boolean; adviser_override boolean; timetable_override boolean;
BEGIN
  SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex'),count(*)::int
    INTO actual_before,actual_before_count FROM registration.add_drop_manifest_items
    WHERE add_drop_request_id=NEW.add_drop_request_id AND manifest_side='BEFORE';
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex'),count(*)::int
    INTO actual_after,actual_after_count FROM registration.add_drop_manifest_items
    WHERE add_drop_request_id=NEW.add_drop_request_id AND manifest_side='AFTER';
  SELECT EXISTS(SELECT 1 FROM registration.add_drop_override_usages
      WHERE add_drop_request_id=NEW.add_drop_request_id AND exception_type='CREDIT_LIMIT'),
    EXISTS(SELECT 1 FROM registration.add_drop_override_usages
      WHERE add_drop_request_id=NEW.add_drop_request_id AND exception_type='ADVISER_APPROVAL'),
    EXISTS(SELECT 1 FROM registration.add_drop_override_usages
      WHERE add_drop_request_id=NEW.add_drop_request_id AND exception_type='TIMETABLE_CONFLICT')
    INTO credit_override,adviser_override,timetable_override;
  IF change.id IS NULL OR change.status<>'PENDING' OR change.requested_by<>NEW.created_by
    OR actual_before<>change.before_manifest_sha256 OR actual_after<>change.after_manifest_sha256
    OR actual_before_count<>change.before_item_count OR actual_after_count<>change.after_item_count
    THEN RAISE EXCEPTION 'invalid add/drop eligibility snapshot'; END IF;
  IF NEW.requested_credit_units>NEW.maximum_credit_units AND NOT credit_override
    THEN RAISE EXCEPTION 'add/drop credit limit override required'; END IF;
  IF NEW.adviser_required AND NEW.adviser_approval_id IS NULL AND NOT adviser_override
    THEN RAISE EXCEPTION 'add/drop adviser approval override required'; END IF;
  IF NOT NEW.adviser_required AND NEW.adviser_approval_id IS NOT NULL
    THEN RAISE EXCEPTION 'unexpected add/drop adviser approval'; END IF;
  IF NEW.timetable_conflict_count>0 AND NOT timetable_override
    THEN RAISE EXCEPTION 'add/drop timetable override required'; END IF;
  IF NEW.adviser_approval_id IS NOT NULL THEN
    SELECT * INTO approval FROM registration.adviser_approvals WHERE id=NEW.adviser_approval_id FOR SHARE;
    IF approval.id IS NULL OR approval.student_id<>change.student_id OR approval.period_id<>change.period_id
      OR approval.offering_manifest_sha256<>actual_after OR approval.scope_type<>change.scope_type
      OR approval.scope_id<>change.scope_id THEN RAISE EXCEPTION 'invalid adviser approval for add/drop'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_eligibility_consistency BEFORE INSERT
ON registration.add_drop_eligibility_snapshots FOR EACH ROW
EXECUTE FUNCTION registration.assert_add_drop_eligibility_snapshot();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_before text; actual_after text; actual_before_count integer; actual_after_count integer;
BEGIN
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex'),count(*)::int
    INTO actual_before,actual_before_count FROM registration.add_drop_manifest_items
    WHERE add_drop_request_id=NEW.id AND manifest_side='BEFORE';
  SELECT encode(digest(COALESCE(string_agg(offering_id::text,',' ORDER BY offering_id),''),'sha256'),'hex'),count(*)::int
    INTO actual_after,actual_after_count FROM registration.add_drop_manifest_items
    WHERE add_drop_request_id=NEW.id AND manifest_side='AFTER';
  IF actual_before<>NEW.before_manifest_sha256 OR actual_after<>NEW.after_manifest_sha256
    OR actual_before_count<>NEW.before_item_count OR actual_after_count<>NEW.after_item_count
    OR NOT EXISTS (SELECT 1 FROM registration.add_drop_eligibility_snapshots
      WHERE add_drop_request_id=NEW.id)
    THEN RAISE EXCEPTION 'incomplete registration add/drop request'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER registration_add_drop_complete_at_commit
AFTER INSERT OR UPDATE ON registration.add_drop_requests DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION registration.assert_add_drop_complete();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change registration.add_drop_requests%ROWTYPE;
BEGIN
  SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
  IF change.id IS NULL OR change.status<>NEW.outcome OR change.decided_by<>NEW.decided_by
    OR change.requested_by=NEW.decided_by OR change.decision_reason<>NEW.reason
    THEN RAISE EXCEPTION 'invalid add/drop decision evidence'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_decision_consistency BEFORE INSERT
ON registration.add_drop_decisions FOR EACH ROW EXECUTE FUNCTION registration.assert_add_drop_decision();

CREATE OR REPLACE FUNCTION registration.assert_add_drop_allocation_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change registration.add_drop_requests%ROWTYPE; expected_pool uuid;
BEGIN
  SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
  SELECT pool_id INTO expected_pool FROM registration.add_drop_capacity_assignments
    WHERE add_drop_request_id=NEW.add_drop_request_id AND offering_id=NEW.offering_id;
  IF change.id IS NULL OR change.status<>'APPROVED'
    OR change.registration_request_id<>NEW.registration_request_id OR change.student_id<>NEW.student_id
    OR change.decided_by<>NEW.recorded_by
    OR (NEW.action='ADD' AND (NOT EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
        WHERE add_drop_request_id=change.id AND manifest_side='AFTER' AND offering_id=NEW.offering_id)
      OR EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
        WHERE add_drop_request_id=change.id AND manifest_side='BEFORE' AND offering_id=NEW.offering_id)
      OR NEW.pool_id IS DISTINCT FROM expected_pool))
    OR (NEW.action='DROP' AND (NOT EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
        WHERE add_drop_request_id=change.id AND manifest_side='BEFORE' AND offering_id=NEW.offering_id)
      OR EXISTS (SELECT 1 FROM registration.add_drop_manifest_items
        WHERE add_drop_request_id=change.id AND manifest_side='AFTER' AND offering_id=NEW.offering_id)))
    THEN RAISE EXCEPTION 'invalid add/drop allocation event'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER registration_add_drop_allocation_event_consistency BEFORE INSERT
ON registration.add_drop_allocation_events FOR EACH ROW
EXECUTE FUNCTION registration.assert_add_drop_allocation_event();

CREATE TRIGGER registration_add_drop_manifest_items_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_manifest_items FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_add_drop_override_usages_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_override_usages FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_add_drop_capacity_assignments_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_capacity_assignments FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_add_drop_eligibility_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_eligibility_snapshots FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_add_drop_decisions_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_decisions FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();
CREATE TRIGGER registration_add_drop_allocation_events_no_mutation BEFORE UPDATE OR DELETE
ON registration.add_drop_allocation_events FOR EACH ROW EXECUTE FUNCTION registration.reject_decision_mutation();

CREATE OR REPLACE FUNCTION registration.assert_confirmed_item_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request registration.requests%ROWTYPE; assignment registration.request_capacity_assignments%ROWTYPE;
  change registration.add_drop_requests%ROWTYPE; change_assignment registration.add_drop_capacity_assignments%ROWTYPE;
BEGIN
  SELECT * INTO request FROM registration.requests WHERE id=NEW.request_id FOR SHARE;
  IF NEW.add_drop_request_id IS NULL THEN
    SELECT * INTO assignment FROM registration.request_capacity_assignments
      WHERE request_id=NEW.request_id AND offering_id=NEW.offering_id;
    IF NOT EXISTS (SELECT 1 FROM registration.request_items
      WHERE request_id=NEW.request_id AND offering_id=NEW.offering_id)
      OR NEW.pool_id IS DISTINCT FROM assignment.pool_id
      THEN RAISE EXCEPTION 'invalid original confirmed registration allocation'; END IF;
  ELSE
    SELECT * INTO change FROM registration.add_drop_requests WHERE id=NEW.add_drop_request_id FOR SHARE;
    SELECT * INTO change_assignment FROM registration.add_drop_capacity_assignments
      WHERE add_drop_request_id=NEW.add_drop_request_id AND offering_id=NEW.offering_id;
    IF change.id IS NULL OR change.status<>'APPROVED' OR change.registration_request_id<>NEW.request_id
      OR NOT EXISTS (SELECT 1 FROM registration.add_drop_manifest_items a
        WHERE a.add_drop_request_id=change.id AND a.manifest_side='AFTER' AND a.offering_id=NEW.offering_id)
      OR EXISTS (SELECT 1 FROM registration.add_drop_manifest_items b
        WHERE b.add_drop_request_id=change.id AND b.manifest_side='BEFORE' AND b.offering_id=NEW.offering_id)
      OR NEW.pool_id IS DISTINCT FROM change_assignment.pool_id
      THEN RAISE EXCEPTION 'invalid add/drop confirmed registration allocation'; END IF;
  END IF;
  IF request.id IS NULL OR request.status<>'CONFIRMED' OR request.student_id<>NEW.student_id
    THEN RAISE EXCEPTION 'invalid confirmed registration allocation'; END IF;
  RETURN NEW;
END; $$;
