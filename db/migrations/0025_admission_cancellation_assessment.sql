ALTER TABLE admissions.offers DROP CONSTRAINT offers_status_check;
ALTER TABLE admissions.offers DROP CONSTRAINT offers_state_check;
ALTER TABLE admissions.offers ADD CONSTRAINT offers_status_check CHECK (
  status IN ('ISSUED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED','CANCELLED'));
ALTER TABLE admissions.offers ADD CONSTRAINT offers_state_check CHECK (
  (status='ISSUED' AND accepted_by IS NULL AND accepted_at IS NULL)
  OR (status IN ('ACCEPTED','CANCELLED') AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
  OR (status IN ('DECLINED','WITHDRAWN','EXPIRED') AND accepted_by IS NULL AND accepted_at IS NULL));

CREATE TABLE admissions.cancellation_requests (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL UNIQUE REFERENCES admissions.offers(id),
  application_id uuid NOT NULL REFERENCES admissions.applications(id),
  idempotency_key uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (
    status IN ('REQUESTED','REJECTED','PENDING_FINANCE','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE admissions.cancellation_assessments (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES admissions.cancellation_requests(id),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  financial_disposition text NOT NULL CHECK (
    financial_disposition IN ('NOT_APPLICABLE','NO_REFUND_REQUIRED','FINANCE_REVIEW_REQUIRED')),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  assessed_by text NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((decision='REJECTED' AND financial_disposition='NOT_APPLICABLE')
    OR (decision='APPROVED' AND financial_disposition IN ('NO_REFUND_REQUIRED','FINANCE_REVIEW_REQUIRED')))
);

CREATE INDEX admission_cancellation_finance_worklist_idx
  ON admissions.cancellation_requests(id) WHERE status='PENDING_FINANCE';

CREATE OR REPLACE FUNCTION admissions.assert_cancellation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer admissions.offers%ROWTYPE;
  application admissions.applications%ROWTYPE;
  request admissions.cancellation_requests%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='cancellation_requests' THEN
    SELECT * INTO offer FROM admissions.offers WHERE id=NEW.offer_id FOR SHARE;
    SELECT * INTO application FROM admissions.applications WHERE id=offer.application_id FOR SHARE;
    IF offer.id IS NULL OR offer.status<>'ACCEPTED' OR application.id IS NULL
      OR NEW.application_id<>offer.application_id
      OR NEW.requested_by<>application.applicant_subject_id
      OR EXISTS (SELECT 1 FROM admissions.conversions WHERE offer_id=offer.id) THEN
      RAISE EXCEPTION 'invalid admission cancellation request';
    END IF;
  ELSIF TG_TABLE_NAME='cancellation_assessments' THEN
    SELECT * INTO request FROM admissions.cancellation_requests WHERE id=NEW.request_id FOR SHARE;
    IF request.id IS NULL OR request.status<>'REQUESTED' OR request.requested_by=NEW.assessed_by THEN
      RAISE EXCEPTION 'invalid admission cancellation assessment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION admissions.protect_cancellation_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment admissions.cancellation_assessments%ROWTYPE;
BEGIN
  IF OLD.status<>'REQUESTED' OR NEW.offer_id<>OLD.offer_id OR NEW.application_id<>OLD.application_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.reason<>OLD.reason
    OR NEW.requested_by<>OLD.requested_by OR NEW.requested_at<>OLD.requested_at
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'admission cancellation request evidence is immutable';
  END IF;
  SELECT * INTO assessment FROM admissions.cancellation_assessments WHERE request_id=OLD.id;
  IF assessment.id IS NULL
    OR (assessment.decision='REJECTED' AND NEW.status<>'REJECTED')
    OR (assessment.decision='APPROVED' AND assessment.financial_disposition='NO_REFUND_REQUIRED'
      AND NEW.status<>'CANCELLED')
    OR (assessment.decision='APPROVED' AND assessment.financial_disposition='FINANCE_REVIEW_REQUIRED'
      AND NEW.status<>'PENDING_FINANCE') THEN
    RAISE EXCEPTION 'cancellation status does not match immutable assessment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admission_cancellation_request_consistency
BEFORE INSERT ON admissions.cancellation_requests
FOR EACH ROW EXECUTE FUNCTION admissions.assert_cancellation_evidence();
CREATE TRIGGER admission_cancellation_assessment_consistency
BEFORE INSERT ON admissions.cancellation_assessments
FOR EACH ROW EXECUTE FUNCTION admissions.assert_cancellation_evidence();
CREATE TRIGGER admission_cancellation_request_transition
BEFORE UPDATE ON admissions.cancellation_requests
FOR EACH ROW EXECUTE FUNCTION admissions.protect_cancellation_request();
CREATE TRIGGER admission_cancellation_requests_no_delete
BEFORE DELETE ON admissions.cancellation_requests
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_cancellation_assessments_no_mutation
BEFORE UPDATE OR DELETE ON admissions.cancellation_assessments
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_accepted_offer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.application_id<>OLD.application_id OR NEW.offer_reference<>OLD.offer_reference
    OR NEW.terms_manifest_sha256<>OLD.terms_manifest_sha256 OR NEW.issued_by<>OLD.issued_by
    OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.policy_reference IS DISTINCT FROM OLD.policy_reference OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'admission offer evidence is immutable';
  END IF;
  IF OLD.status='ISSUED' THEN
    IF NEW.status NOT IN ('ACCEPTED','DECLINED','WITHDRAWN','EXPIRED') THEN
      RAISE EXCEPTION 'invalid issued offer transition';
    END IF;
    IF NEW.status IN ('DECLINED','WITHDRAWN','EXPIRED') AND NOT EXISTS (
      SELECT 1 FROM admissions.offer_lifecycle_events
      WHERE offer_id=OLD.id AND from_status=OLD.status AND to_status=NEW.status) THEN
      RAISE EXCEPTION 'terminal offer transition requires lifecycle evidence';
    END IF;
  ELSIF OLD.status='ACCEPTED' THEN
    IF NEW.status<>'CANCELLED' OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by
      OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NOT EXISTS (
        SELECT 1 FROM admissions.cancellation_requests r
        JOIN admissions.cancellation_assessments a ON a.request_id=r.id
        WHERE r.offer_id=OLD.id AND r.status='CANCELLED' AND a.decision='APPROVED'
          AND a.financial_disposition='NO_REFUND_REQUIRED') THEN
      RAISE EXCEPTION 'accepted offer cancellation requires approved no-refund assessment';
    END IF;
  ELSE
    RAISE EXCEPTION 'decided admission offer is immutable';
  END IF;
  RETURN NEW;
END;
$$;
