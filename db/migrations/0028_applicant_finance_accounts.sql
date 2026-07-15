ALTER TABLE finance.student_accounts RENAME TO accounts;
ALTER TABLE finance.accounts ALTER COLUMN student_id DROP NOT NULL;
ALTER TABLE finance.accounts ADD COLUMN application_id uuid REFERENCES admissions.applications(id);
ALTER TABLE finance.accounts ADD COLUMN policy_reference text
  CHECK (policy_reference IS NULL OR char_length(policy_reference) BETWEEN 3 AND 300);
ALTER TABLE finance.accounts DROP CONSTRAINT student_accounts_student_id_currency_key;
ALTER TABLE finance.accounts ADD CONSTRAINT finance_account_single_origin CHECK (
  (student_id IS NOT NULL AND application_id IS NULL AND policy_reference IS NULL)
  OR (student_id IS NULL AND application_id IS NOT NULL AND policy_reference IS NOT NULL));
CREATE UNIQUE INDEX finance_account_student_currency
  ON finance.accounts(student_id,currency) WHERE student_id IS NOT NULL;
CREATE UNIQUE INDEX finance_account_application_currency
  ON finance.accounts(application_id,currency) WHERE application_id IS NOT NULL;
CREATE TRIGGER finance_accounts_no_mutation
BEFORE UPDATE OR DELETE ON finance.accounts
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();

CREATE TABLE finance.account_student_links (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES finance.accounts(id),
  application_id uuid NOT NULL REFERENCES admissions.applications(id),
  student_id uuid NOT NULL REFERENCES student.records(id),
  conversion_id uuid NOT NULL REFERENCES admissions.conversions(id),
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (application_id,student_id,account_id)
);

CREATE OR REPLACE FUNCTION finance.assert_account_student_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account finance.accounts%ROWTYPE;
  conversion admissions.conversions%ROWTYPE;
BEGIN
  SELECT * INTO account FROM finance.accounts WHERE id=NEW.account_id FOR SHARE;
  SELECT * INTO conversion FROM admissions.conversions WHERE id=NEW.conversion_id FOR SHARE;
  IF account.id IS NULL OR account.student_id IS NOT NULL OR account.application_id<>NEW.application_id
    OR conversion.id IS NULL OR conversion.application_id<>NEW.application_id
    OR conversion.student_id<>NEW.student_id OR conversion.converted_by<>NEW.linked_by THEN
    RAISE EXCEPTION 'invalid applicant-account student link';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finance_account_student_link_consistency
BEFORE INSERT ON finance.account_student_links
FOR EACH ROW EXECUTE FUNCTION finance.assert_account_student_link();
CREATE TRIGGER finance_account_student_links_no_mutation
BEFORE UPDATE OR DELETE ON finance.account_student_links
FOR EACH ROW EXECUTE FUNCTION finance.reject_ledger_mutation();
