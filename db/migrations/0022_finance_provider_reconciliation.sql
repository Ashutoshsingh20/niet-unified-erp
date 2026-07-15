ALTER TABLE finance.postings DROP CONSTRAINT postings_posting_type_check;
ALTER TABLE finance.postings DROP CONSTRAINT postings_check;
ALTER TABLE finance.postings DROP CONSTRAINT postings_original_posting_id_key;

ALTER TABLE finance.postings ADD CONSTRAINT postings_posting_type_check
  CHECK (posting_type IN ('DEMAND', 'PAYMENT', 'REVERSAL', 'REFUND'));
ALTER TABLE finance.postings ADD CONSTRAINT postings_derivation_check CHECK (
  (posting_type IN ('REVERSAL', 'REFUND') AND original_posting_id IS NOT NULL
    AND approved_by IS NOT NULL AND requested_by <> approved_by)
  OR
  (posting_type IN ('DEMAND', 'PAYMENT') AND original_posting_id IS NULL AND approved_by IS NULL)
);
CREATE UNIQUE INDEX finance_one_reversal_per_posting
  ON finance.postings(original_posting_id) WHERE posting_type = 'REVERSAL';
CREATE INDEX finance_refund_postings_by_original
  ON finance.postings(original_posting_id, posted_at) WHERE posting_type = 'REFUND';

CREATE TABLE finance.provider_events (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type = 'PAYMENT_CONFIRMED'),
  account_id uuid NOT NULL REFERENCES finance.student_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  verification_engine text NOT NULL CHECK (char_length(verification_engine) BETWEEN 1 AND 100),
  verification_version text NOT NULL CHECK (char_length(verification_version) BETWEEN 1 AND 100),
  verification_trace_reference text NOT NULL
    CHECK (char_length(verification_trace_reference) BETWEEN 3 AND 300),
  provider_occurred_at timestamptz NOT NULL,
  posting_id uuid NOT NULL UNIQUE REFERENCES finance.postings(id),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_key, provider_event_id)
);
CREATE INDEX provider_events_reconciliation_window
  ON finance.provider_events(provider_key, currency, provider_occurred_at, id);

CREATE TABLE finance.receipts (
  id uuid PRIMARY KEY,
  payment_posting_id uuid NOT NULL UNIQUE REFERENCES finance.postings(id),
  document_manifest_sha256 char(64) NOT NULL CHECK (document_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE finance.reconciliation_batches (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expected_event_count integer NOT NULL CHECK (expected_event_count >= 0),
  expected_amount_minor bigint NOT NULL CHECK (expected_amount_minor >= 0),
  actual_event_count integer NOT NULL CHECK (actual_event_count >= 0),
  actual_amount_minor bigint NOT NULL CHECK (actual_amount_minor >= 0),
  event_set_sha256 char(64) NOT NULL CHECK (event_set_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_cutoff timestamptz NOT NULL,
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_start < period_end)
);
CREATE INDEX reconciliation_batches_provider_period
  ON finance.reconciliation_batches(provider_key, scope_type, scope_id, currency, period_start, period_end);

CREATE TABLE finance.reconciliation_approvals (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL UNIQUE REFERENCES finance.reconciliation_batches(id),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE finance.refund_requests (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  original_payment_posting_id uuid NOT NULL REFERENCES finance.postings(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE finance.refund_decisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES finance.refund_requests(id),
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX finance_refund_requests_by_payment
  ON finance.refund_requests(original_payment_posting_id, requested_at);

CREATE TABLE finance.refunds (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES finance.refund_requests(id),
  refund_posting_id uuid NOT NULL UNIQUE REFERENCES finance.postings(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION finance.assert_finance_evidence_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE posting finance.postings%ROWTYPE; request finance.refund_requests%ROWTYPE;
  batch finance.reconciliation_batches%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'provider_events' THEN
    SELECT * INTO posting FROM finance.postings WHERE id = NEW.posting_id;
    IF posting.posting_type <> 'PAYMENT' OR posting.account_id <> NEW.account_id
      OR posting.amount_minor <> NEW.amount_minor OR posting.currency <> NEW.currency
      OR posting.evidence_reference <> NEW.verification_trace_reference THEN
      RAISE EXCEPTION 'provider event does not match its payment posting';
    END IF;
  ELSIF TG_TABLE_NAME = 'receipts' THEN
    SELECT * INTO posting FROM finance.postings WHERE id = NEW.payment_posting_id;
    IF posting.posting_type <> 'PAYMENT' THEN RAISE EXCEPTION 'receipt must reference a payment posting'; END IF;
  ELSIF TG_TABLE_NAME = 'refund_decisions' THEN
    SELECT * INTO request FROM finance.refund_requests WHERE id = NEW.request_id;
    IF request.requested_by = NEW.decided_by THEN RAISE EXCEPTION 'refund maker cannot decide request'; END IF;
  ELSIF TG_TABLE_NAME = 'refunds' THEN
    SELECT rr.* INTO request FROM finance.refund_requests rr
      JOIN finance.refund_decisions rd ON rd.request_id=rr.id
      WHERE rr.id=NEW.request_id AND rd.decision='APPROVED';
    SELECT * INTO posting FROM finance.postings WHERE id=NEW.refund_posting_id;
    IF request.id IS NULL OR posting.posting_type <> 'REFUND'
      OR posting.original_posting_id <> request.original_payment_posting_id
      OR posting.amount_minor <> request.amount_minor OR posting.currency <> request.currency THEN
      RAISE EXCEPTION 'refund evidence does not match its approved request';
    END IF;
  ELSIF TG_TABLE_NAME = 'reconciliation_approvals' THEN
    SELECT * INTO batch FROM finance.reconciliation_batches WHERE id=NEW.batch_id;
    IF batch.created_by = NEW.approved_by THEN RAISE EXCEPTION 'reconciliation maker cannot approve batch'; END IF;
    IF batch.expected_event_count <> batch.actual_event_count
      OR batch.expected_amount_minor <> batch.actual_amount_minor THEN
      RAISE EXCEPTION 'reconciliation control totals do not match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finance_provider_event_consistency BEFORE INSERT ON finance.provider_events
FOR EACH ROW EXECUTE FUNCTION finance.assert_finance_evidence_consistency();
CREATE TRIGGER finance_receipt_consistency BEFORE INSERT ON finance.receipts
FOR EACH ROW EXECUTE FUNCTION finance.assert_finance_evidence_consistency();
CREATE TRIGGER finance_refund_decision_consistency BEFORE INSERT ON finance.refund_decisions
FOR EACH ROW EXECUTE FUNCTION finance.assert_finance_evidence_consistency();
CREATE TRIGGER finance_refund_consistency BEFORE INSERT ON finance.refunds
FOR EACH ROW EXECUTE FUNCTION finance.assert_finance_evidence_consistency();
CREATE TRIGGER finance_reconciliation_approval_consistency BEFORE INSERT ON finance.reconciliation_approvals
FOR EACH ROW EXECUTE FUNCTION finance.assert_finance_evidence_consistency();

CREATE OR REPLACE FUNCTION finance.assert_derived_posting_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original finance.postings%ROWTYPE; linked_count integer; refunded numeric;
BEGIN
  IF NEW.posting_type NOT IN ('REVERSAL','REFUND') THEN RETURN NULL; END IF;
  SELECT * INTO original FROM finance.postings WHERE id=NEW.original_posting_id;
  IF NEW.posting_type='REVERSAL' AND original.posting_type NOT IN ('DEMAND','PAYMENT') THEN
    RAISE EXCEPTION 'reversal must derive from an original demand or payment';
  END IF;
  IF NEW.posting_type='REFUND' THEN
    IF original.posting_type <> 'PAYMENT' THEN RAISE EXCEPTION 'refund must derive from an original payment'; END IF;
    SELECT count(*) INTO linked_count FROM finance.refunds WHERE refund_posting_id=NEW.id;
    IF linked_count <> 1 THEN RAISE EXCEPTION 'refund posting requires one approved refund record'; END IF;
    SELECT COALESCE(sum(amount_minor),0) INTO refunded FROM finance.postings
      WHERE original_posting_id=original.id AND posting_type='REFUND';
    IF refunded > original.amount_minor THEN RAISE EXCEPTION 'refund postings exceed original payment'; END IF;
    IF EXISTS (SELECT 1 FROM finance.postings
      WHERE original_posting_id=original.id AND posting_type='REVERSAL') THEN
      RAISE EXCEPTION 'reversed payment cannot have refunds';
    END IF;
  ELSIF original.posting_type='PAYMENT' AND EXISTS (
    SELECT 1 FROM finance.refund_requests rr LEFT JOIN finance.refund_decisions rd ON rd.request_id=rr.id
    WHERE rr.original_payment_posting_id=original.id AND COALESCE(rd.decision,'APPROVED') <> 'REJECTED'
  ) THEN RAISE EXCEPTION 'payment with an active refund request cannot be reversed';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER finance_derived_posting_consistent
AFTER INSERT ON finance.postings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.assert_derived_posting_consistency();

CREATE TRIGGER finance_provider_events_no_mutation BEFORE UPDATE OR DELETE ON finance.provider_events
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_receipts_no_mutation BEFORE UPDATE OR DELETE ON finance.receipts
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_reconciliation_batches_no_mutation BEFORE UPDATE OR DELETE ON finance.reconciliation_batches
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_reconciliation_approvals_no_mutation BEFORE UPDATE OR DELETE ON finance.reconciliation_approvals
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_refund_requests_no_mutation BEFORE UPDATE OR DELETE ON finance.refund_requests
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_refund_decisions_no_mutation BEFORE UPDATE OR DELETE ON finance.refund_decisions
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_refunds_no_mutation BEFORE UPDATE OR DELETE ON finance.refunds
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
