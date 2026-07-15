CREATE TABLE admissions.cancellation_finance_resolutions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES admissions.cancellation_requests(id),
  outcome text NOT NULL CHECK (outcome IN ('CANCELLED','REJECTED')),
  financial_outcome text NOT NULL CHECK (
    financial_outcome IN ('NO_REFUND_REQUIRED','REFUND_REJECTED','REFUND_COMPLETED')),
  finance_refund_request_id uuid UNIQUE REFERENCES finance.refund_requests(id),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  resolved_by text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((financial_outcome='REFUND_COMPLETED' AND finance_refund_request_id IS NOT NULL)
    OR (financial_outcome<>'REFUND_COMPLETED' AND finance_refund_request_id IS NULL))
);

CREATE OR REPLACE FUNCTION admissions.assert_cancellation_finance_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request admissions.cancellation_requests%ROWTYPE;
  assessment admissions.cancellation_assessments%ROWTYPE;
BEGIN
  SELECT * INTO request FROM admissions.cancellation_requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO assessment FROM admissions.cancellation_assessments WHERE request_id=NEW.request_id;
  IF request.id IS NULL OR request.status<>'PENDING_FINANCE'
    OR assessment.id IS NULL OR assessment.financial_disposition<>'FINANCE_REVIEW_REQUIRED'
    OR NEW.resolved_by IN (request.requested_by,assessment.assessed_by) THEN
    RAISE EXCEPTION 'invalid admission cancellation finance resolution';
  END IF;
  IF NEW.finance_refund_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.refund_requests rr
    JOIN finance.refund_decisions rd ON rd.request_id=rr.id AND rd.decision='APPROVED'
    JOIN finance.refunds rf ON rf.request_id=rr.id
    WHERE rr.id=NEW.finance_refund_request_id
      AND rr.evidence_reference='admission-cancellation:' || NEW.request_id::text) THEN
    RAISE EXCEPTION 'finance resolution must reference a completed approved refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admission_cancellation_finance_resolution_consistency
BEFORE INSERT ON admissions.cancellation_finance_resolutions
FOR EACH ROW EXECUTE FUNCTION admissions.assert_cancellation_finance_resolution();
CREATE TRIGGER admission_cancellation_finance_resolutions_no_mutation
BEFORE UPDATE OR DELETE ON admissions.cancellation_finance_resolutions
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION admissions.protect_cancellation_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment admissions.cancellation_assessments%ROWTYPE;
  resolution admissions.cancellation_finance_resolutions%ROWTYPE;
BEGIN
  IF NEW.offer_id<>OLD.offer_id OR NEW.application_id<>OLD.application_id
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.reason<>OLD.reason
    OR NEW.requested_by<>OLD.requested_by OR NEW.requested_at<>OLD.requested_at
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'admission cancellation request evidence is immutable';
  END IF;
  IF OLD.status='REQUESTED' THEN
    SELECT * INTO assessment FROM admissions.cancellation_assessments WHERE request_id=OLD.id;
    IF assessment.id IS NULL
      OR (assessment.decision='REJECTED' AND NEW.status<>'REJECTED')
      OR (assessment.decision='APPROVED' AND assessment.financial_disposition='NO_REFUND_REQUIRED'
        AND NEW.status<>'CANCELLED')
      OR (assessment.decision='APPROVED' AND assessment.financial_disposition='FINANCE_REVIEW_REQUIRED'
        AND NEW.status<>'PENDING_FINANCE') THEN
      RAISE EXCEPTION 'cancellation status does not match immutable assessment';
    END IF;
  ELSIF OLD.status='PENDING_FINANCE' THEN
    SELECT * INTO resolution FROM admissions.cancellation_finance_resolutions WHERE request_id=OLD.id;
    IF resolution.id IS NULL OR NEW.status<>resolution.outcome THEN
      RAISE EXCEPTION 'cancellation status does not match immutable finance resolution';
    END IF;
  ELSE
    RAISE EXCEPTION 'terminal admission cancellation request is immutable';
  END IF;
  RETURN NEW;
END;
$$;

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
        LEFT JOIN admissions.cancellation_finance_resolutions fr ON fr.request_id=r.id
        WHERE r.offer_id=OLD.id AND r.status='CANCELLED' AND a.decision='APPROVED'
          AND (a.financial_disposition='NO_REFUND_REQUIRED'
            OR (a.financial_disposition='FINANCE_REVIEW_REQUIRED' AND fr.outcome='CANCELLED'))) THEN
      RAISE EXCEPTION 'accepted offer cancellation requires completed governed evidence';
    END IF;
  ELSE
    RAISE EXCEPTION 'decided admission offer is immutable';
  END IF;
  RETURN NEW;
END;
$$;
