ALTER TABLE admissions.offers ADD COLUMN expires_at timestamptz;
ALTER TABLE admissions.offers ADD COLUMN policy_reference text;

ALTER TABLE admissions.offers DROP CONSTRAINT offers_status_check;
ALTER TABLE admissions.offers DROP CONSTRAINT offers_check;
ALTER TABLE admissions.offers ADD CONSTRAINT offers_status_check CHECK (
  status IN ('ISSUED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED'));
ALTER TABLE admissions.offers ADD CONSTRAINT offers_state_check CHECK (
  (status='ISSUED' AND accepted_by IS NULL AND accepted_at IS NULL)
  OR (status='ACCEPTED' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
  OR (status IN ('DECLINED','WITHDRAWN','EXPIRED') AND accepted_by IS NULL AND accepted_at IS NULL));
ALTER TABLE admissions.offers ADD CONSTRAINT offers_expiry_policy_check CHECK (
  (expires_at IS NULL AND policy_reference IS NULL)
  OR (expires_at IS NOT NULL AND policy_reference IS NOT NULL
    AND char_length(policy_reference) BETWEEN 3 AND 300));

CREATE INDEX admission_offers_expiry_worklist_idx
  ON admissions.offers(status,expires_at,id) WHERE status='ISSUED';

CREATE TABLE admissions.offer_lifecycle_events (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES admissions.offers(id),
  application_id uuid NOT NULL REFERENCES admissions.applications(id),
  transition text NOT NULL CHECK (transition IN ('DECLINED','WITHDRAWN','EXPIRED')),
  from_status text NOT NULL CHECK (from_status='ISSUED'),
  to_status text NOT NULL CHECK (to_status=transition),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  acted_by text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (offer_id)
);

CREATE OR REPLACE FUNCTION admissions.assert_offer_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer admissions.offers%ROWTYPE;
  application admissions.applications%ROWTYPE;
BEGIN
  SELECT * INTO offer FROM admissions.offers WHERE id=NEW.offer_id FOR SHARE;
  SELECT * INTO application FROM admissions.applications WHERE id=offer.application_id FOR SHARE;
  IF offer.id IS NULL OR application.id IS NULL OR offer.status<>'ISSUED'
    OR NEW.application_id<>offer.application_id OR NEW.to_status<>NEW.transition
    OR NEW.policy_reference IS DISTINCT FROM offer.policy_reference THEN
    RAISE EXCEPTION 'invalid admission offer lifecycle evidence';
  END IF;
  IF NEW.transition='DECLINED' AND NEW.acted_by<>application.applicant_subject_id THEN
    RAISE EXCEPTION 'only the applicant can decline an admission offer';
  END IF;
  IF NEW.transition IN ('WITHDRAWN','EXPIRED') AND NEW.acted_by=offer.issued_by THEN
    RAISE EXCEPTION 'offer issuer cannot perform exceptional lifecycle transition';
  END IF;
  IF NEW.transition='EXPIRED' AND (offer.expires_at IS NULL OR offer.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'admission offer has not reached configured expiry';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admission_offer_lifecycle_event_consistency
BEFORE INSERT ON admissions.offer_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION admissions.assert_offer_lifecycle_event();
CREATE TRIGGER admission_offer_lifecycle_events_no_mutation
BEFORE UPDATE OR DELETE ON admissions.offer_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_accepted_offer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'ISSUED' THEN RAISE EXCEPTION 'decided admission offer is immutable'; END IF;
  IF NEW.application_id<>OLD.application_id OR NEW.offer_reference<>OLD.offer_reference
    OR NEW.terms_manifest_sha256<>OLD.terms_manifest_sha256 OR NEW.issued_by<>OLD.issued_by
    OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.policy_reference IS DISTINCT FROM OLD.policy_reference
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'admission offer evidence is immutable';
  END IF;
  IF NEW.status IN ('DECLINED','WITHDRAWN','EXPIRED') AND NOT EXISTS (
    SELECT 1 FROM admissions.offer_lifecycle_events
    WHERE offer_id=OLD.id AND from_status=OLD.status AND to_status=NEW.status) THEN
    RAISE EXCEPTION 'terminal offer transition requires lifecycle evidence';
  END IF;
  RETURN NEW;
END; $$;
