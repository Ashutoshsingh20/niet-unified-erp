CREATE TABLE admissions.conversion_exception_cases (
  id uuid PRIMARY KEY,
  conversion_id uuid NOT NULL REFERENCES admissions.conversions(id),
  issue_code text NOT NULL CHECK (issue_code IN ('APPLICATION_STATE_MISMATCH','OFFER_STATE_MISMATCH',
    'STUDENT_SOURCE_MISMATCH','FINANCE_LINK_MISSING','SEAT_CONSUMPTION_MISMATCH')),
  fingerprint_sha256 char(64) NOT NULL CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  scope_type text NOT NULL CHECK (scope_type ~ '^[a-z][a-z0-9_.-]{1,49}$'),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','WAIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  detected_by text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversion_id,issue_code,fingerprint_sha256)
);

CREATE TABLE admissions.conversion_exception_resolutions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES admissions.conversion_exception_cases(id),
  outcome text NOT NULL CHECK (outcome IN ('RESOLVED','WAIVED')),
  evaluation_engine text NOT NULL CHECK (evaluation_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  evaluation_version text NOT NULL CHECK (evaluation_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  evaluation_trace jsonb NOT NULL CHECK (jsonb_typeof(evaluation_trace)='object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  resolved_by text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION admissions.protect_conversion_exception_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'conversion exception evidence is append-only'; END IF;
  IF OLD.status<>'OPEN' OR NEW.status NOT IN ('RESOLVED','WAIVED') OR NEW.version<>OLD.version+1
    OR NEW.conversion_id<>OLD.conversion_id OR NEW.issue_code<>OLD.issue_code
    OR NEW.fingerprint_sha256<>OLD.fingerprint_sha256 OR NEW.details<>OLD.details
    OR NEW.scope_type<>OLD.scope_type OR NEW.scope_id<>OLD.scope_id
    OR NEW.detected_by<>OLD.detected_by OR NEW.detected_at<>OLD.detected_at
    OR NOT EXISTS (SELECT 1 FROM admissions.conversion_exception_resolutions r
      WHERE r.case_id=OLD.id AND r.outcome=NEW.status) THEN
    RAISE EXCEPTION 'invalid conversion exception transition';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_conversion_exception_case_guard BEFORE UPDATE OR DELETE
ON admissions.conversion_exception_cases FOR EACH ROW
EXECUTE FUNCTION admissions.protect_conversion_exception_case();

CREATE OR REPLACE FUNCTION admissions.assert_conversion_exception_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exception_case admissions.conversion_exception_cases%ROWTYPE;
  conversion admissions.conversions%ROWTYPE;
BEGIN
  SELECT * INTO exception_case FROM admissions.conversion_exception_cases WHERE id=NEW.case_id FOR SHARE;
  SELECT * INTO conversion FROM admissions.conversions WHERE id=exception_case.conversion_id FOR SHARE;
  IF exception_case.id IS NULL OR exception_case.status<>'OPEN' OR conversion.id IS NULL
    OR NEW.resolved_by IN (exception_case.detected_by,conversion.converted_by) THEN
    RAISE EXCEPTION 'invalid conversion exception resolution';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER admission_conversion_exception_resolution_consistency BEFORE INSERT
ON admissions.conversion_exception_resolutions FOR EACH ROW
EXECUTE FUNCTION admissions.assert_conversion_exception_resolution();
CREATE TRIGGER admission_conversion_exception_resolutions_no_mutation BEFORE UPDATE OR DELETE
ON admissions.conversion_exception_resolutions FOR EACH ROW
EXECUTE FUNCTION admissions.reject_evidence_mutation();
