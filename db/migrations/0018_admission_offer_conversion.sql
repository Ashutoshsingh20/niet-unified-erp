ALTER TABLE admissions.applications DROP CONSTRAINT applications_status_check;
ALTER TABLE admissions.applications DROP CONSTRAINT applications_check;
ALTER TABLE admissions.applications ADD CONSTRAINT applications_status_check CHECK (
  status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','OFFERED','REJECTED','WITHDRAWN','CONVERTED'));
ALTER TABLE admissions.applications ADD CONSTRAINT applications_state_check CHECK (
  (status='DRAFT' AND submitted_at IS NULL AND decided_at IS NULL)
  OR (status IN ('SUBMITTED','UNDER_REVIEW') AND submitted_at IS NOT NULL AND decided_at IS NULL)
  OR (status IN ('OFFERED','REJECTED','CONVERTED') AND submitted_at IS NOT NULL AND decided_at IS NOT NULL)
  OR status='WITHDRAWN');

CREATE TABLE admissions.offers (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL UNIQUE REFERENCES admissions.applications(id),
  offer_reference text NOT NULL UNIQUE CHECK (offer_reference ~ '^[a-zA-Z0-9_.-]{3,100}$'),
  terms_manifest_sha256 text NOT NULL CHECK (terms_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','ACCEPTED','DECLINED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_by text,
  accepted_at timestamptz,
  CHECK ((status='ISSUED' AND accepted_by IS NULL AND accepted_at IS NULL)
    OR (status='ACCEPTED' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
    OR status='DECLINED')
);

CREATE TABLE admissions.conversions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL UNIQUE REFERENCES admissions.applications(id),
  offer_id uuid NOT NULL UNIQUE REFERENCES admissions.offers(id),
  student_id uuid NOT NULL UNIQUE REFERENCES student.records(id),
  idempotency_key uuid NOT NULL UNIQUE,
  mapping_engine text NOT NULL CHECK (mapping_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  mapping_version text NOT NULL CHECK (mapping_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  mapping_trace jsonb NOT NULL CHECK (jsonb_typeof(mapping_trace)='object'),
  converted_by text NOT NULL,
  converted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER admissions_offers_no_delete BEFORE DELETE ON admissions.offers
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admissions_conversions_no_mutation BEFORE UPDATE OR DELETE ON admissions.conversions
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_accepted_offer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'ISSUED' THEN RAISE EXCEPTION 'decided admission offer is immutable'; END IF;
  IF NEW.application_id<>OLD.application_id OR NEW.offer_reference<>OLD.offer_reference
    OR NEW.terms_manifest_sha256<>OLD.terms_manifest_sha256 OR NEW.issued_by<>OLD.issued_by
    OR NEW.issued_at<>OLD.issued_at THEN RAISE EXCEPTION 'admission offer evidence is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admissions_offer_transition_guard BEFORE UPDATE ON admissions.offers
FOR EACH ROW EXECUTE FUNCTION admissions.protect_accepted_offer();
