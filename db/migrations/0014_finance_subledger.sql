CREATE SCHEMA finance;

CREATE TABLE finance.student_accounts (
  id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES student.records(id),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (student_id, currency)
);

CREATE TABLE finance.postings (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES finance.student_accounts(id),
  posting_type text NOT NULL CHECK (posting_type IN ('DEMAND', 'PAYMENT', 'REVERSAL')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key uuid NOT NULL UNIQUE,
  evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 3 AND 300),
  original_posting_id uuid REFERENCES finance.postings(id),
  requested_by text NOT NULL,
  approved_by text,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((posting_type = 'REVERSAL' AND original_posting_id IS NOT NULL AND approved_by IS NOT NULL
      AND requested_by <> approved_by)
    OR (posting_type <> 'REVERSAL' AND original_posting_id IS NULL AND approved_by IS NULL)),
  UNIQUE (original_posting_id)
);

CREATE TABLE finance.ledger_entries (
  id uuid PRIMARY KEY,
  posting_id uuid NOT NULL REFERENCES finance.postings(id),
  ledger_account text NOT NULL CHECK (ledger_account IN ('RECEIVABLE', 'REVENUE', 'PAYMENT_CLEARING')),
  direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (posting_id, ledger_account, direction)
);

CREATE OR REPLACE FUNCTION finance.assert_balanced_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; debits numeric; credits numeric; entry_currency_count integer;
BEGIN
  target_id := COALESCE(NEW.posting_id, OLD.posting_id);
  SELECT COALESCE(sum(amount_minor) FILTER (WHERE direction='DEBIT'),0),
         COALESCE(sum(amount_minor) FILTER (WHERE direction='CREDIT'),0),
         count(DISTINCT currency)
    INTO debits,credits,entry_currency_count FROM finance.ledger_entries WHERE posting_id=target_id;
  IF debits = 0 OR debits <> credits OR entry_currency_count <> 1 OR EXISTS (
    SELECT 1 FROM finance.postings p JOIN finance.ledger_entries e ON e.posting_id=p.id
    WHERE p.id=target_id AND p.currency<>e.currency
  ) THEN RAISE EXCEPTION 'finance posting must be balanced in one currency'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER finance_posting_balanced
AFTER INSERT OR UPDATE OR DELETE ON finance.ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.assert_balanced_posting();

CREATE OR REPLACE FUNCTION finance.reject_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'finance subledger is append-only'; END; $$;
CREATE TRIGGER finance_postings_no_mutation BEFORE UPDATE OR DELETE ON finance.postings
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
CREATE TRIGGER finance_entries_no_mutation BEFORE UPDATE OR DELETE ON finance.ledger_entries
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
