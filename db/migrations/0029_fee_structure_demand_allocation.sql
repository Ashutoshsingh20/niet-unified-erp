CREATE TABLE finance.fee_structures (
  id uuid PRIMARY KEY,
  structure_key text NOT NULL CHECK (structure_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  version integer NOT NULL CHECK (version>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 200),
  line_manifest_sha256 char(64) NOT NULL CHECK (line_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version>0),
  policy_decision_reference text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  UNIQUE (structure_key,version),
  CHECK ((status='DRAFT' AND policy_decision_reference IS NULL AND published_by IS NULL AND published_at IS NULL)
    OR (status='PUBLISHED' AND char_length(policy_decision_reference) BETWEEN 3 AND 300
      AND published_by IS NOT NULL AND published_at IS NOT NULL AND created_by<>published_by))
);

CREATE TABLE finance.fee_structure_lines (
  id uuid PRIMARY KEY,
  structure_id uuid NOT NULL REFERENCES finance.fee_structures(id),
  line_key text NOT NULL CHECK (line_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  fee_head_key text NOT NULL CHECK (fee_head_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  installment_key text NOT NULL CHECK (installment_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  due_on date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  allocation_order integer NOT NULL CHECK (allocation_order>0),
  UNIQUE (structure_id,line_key),
  UNIQUE (structure_id,allocation_order)
);

CREATE TABLE finance.governed_demands (
  posting_id uuid PRIMARY KEY REFERENCES finance.postings(id),
  structure_id uuid NOT NULL REFERENCES finance.fee_structures(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  selected_lines_manifest_sha256 char(64) NOT NULL CHECK (selected_lines_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE finance.demand_allocations (
  id uuid PRIMARY KEY,
  posting_id uuid NOT NULL REFERENCES finance.governed_demands(posting_id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  fee_structure_line_id uuid NOT NULL REFERENCES finance.fee_structure_lines(id),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (posting_id,fee_structure_line_id),
  UNIQUE (account_id,fee_structure_line_id)
);

CREATE OR REPLACE FUNCTION finance.protect_fee_structure()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count integer; actual_manifest text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'fee structure evidence is append-only'; END IF;
  IF OLD.status<>'DRAFT' OR NEW.status<>'PUBLISHED' OR NEW.record_version<>OLD.record_version+1
    OR NEW.structure_key<>OLD.structure_key OR NEW.version<>OLD.version OR NEW.title<>OLD.title
    OR NEW.currency<>OLD.currency OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.line_count<>OLD.line_count
    OR NEW.line_manifest_sha256<>OLD.line_manifest_sha256
    OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
    OR NEW.published_by=OLD.created_by THEN
    RAISE EXCEPTION 'invalid fee structure publication';
  END IF;
  SELECT count(*)::int,encode(digest(COALESCE(string_agg(
      octet_length(line_key)::text || ':' || line_key
      || octet_length(fee_head_key)::text || ':' || fee_head_key
      || octet_length(title)::text || ':' || title
      || octet_length(installment_key)::text || ':' || installment_key
      || 10::text || ':' || due_on::text
      || octet_length(amount_minor::text)::text || ':' || amount_minor::text
      || octet_length(allocation_order::text)::text || ':' || allocation_order::text,
      '' ORDER BY allocation_order),''),'sha256'),'hex')
    INTO actual_count,actual_manifest FROM finance.fee_structure_lines WHERE structure_id=OLD.id;
  IF actual_count<>OLD.line_count OR actual_manifest<>OLD.line_manifest_sha256 THEN
    RAISE EXCEPTION 'fee structure lines do not match their declared manifest';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_fee_structure_guard BEFORE UPDATE OR DELETE ON finance.fee_structures
FOR EACH ROW EXECUTE FUNCTION finance.protect_fee_structure();
CREATE OR REPLACE FUNCTION finance.assert_fee_structure_line_draft()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finance.fee_structures WHERE id=NEW.structure_id AND status='DRAFT') THEN
    RAISE EXCEPTION 'fee structure lines require a draft structure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_fee_structure_line_draft_guard BEFORE INSERT ON finance.fee_structure_lines
FOR EACH ROW EXECUTE FUNCTION finance.assert_fee_structure_line_draft();
CREATE TRIGGER finance_fee_structure_lines_no_mutation BEFORE UPDATE OR DELETE ON finance.fee_structure_lines
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_governed_demands_no_mutation BEFORE UPDATE OR DELETE ON finance.governed_demands
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_demand_allocations_no_mutation BEFORE UPDATE OR DELETE ON finance.demand_allocations
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();

CREATE OR REPLACE FUNCTION finance.assert_governed_demand()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE posting finance.postings%ROWTYPE; account finance.accounts%ROWTYPE;
  structure finance.fee_structures%ROWTYPE; allocation_total numeric; bad_lines integer;
BEGIN
  SELECT * INTO posting FROM finance.postings WHERE id=NEW.posting_id;
  SELECT * INTO account FROM finance.accounts WHERE id=NEW.account_id;
  SELECT * INTO structure FROM finance.fee_structures WHERE id=NEW.structure_id;
  SELECT COALESCE(sum(da.amount_minor),0),count(*) FILTER (WHERE l.structure_id<>NEW.structure_id
      OR da.account_id<>NEW.account_id OR da.amount_minor<>l.amount_minor)
    INTO allocation_total,bad_lines FROM finance.demand_allocations da
    JOIN finance.fee_structure_lines l ON l.id=da.fee_structure_line_id
    WHERE da.posting_id=NEW.posting_id;
  IF posting.id IS NULL OR posting.posting_type<>'DEMAND' OR posting.account_id<>NEW.account_id
    OR structure.id IS NULL OR structure.status<>'PUBLISHED'
    OR structure.currency<>posting.currency OR account.currency<>posting.currency
    OR structure.scope_type<>account.scope_type OR structure.scope_id<>account.scope_id
    OR allocation_total<>posting.amount_minor OR bad_lines<>0 THEN
    RAISE EXCEPTION 'governed demand does not match published fee structure allocations';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER finance_governed_demand_consistent
AFTER INSERT ON finance.governed_demands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_governed_demand();
