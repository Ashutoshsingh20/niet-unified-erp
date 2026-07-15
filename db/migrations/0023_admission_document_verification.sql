CREATE TABLE admissions.document_checklists (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL UNIQUE REFERENCES admissions.applications(id),
  idempotency_key uuid NOT NULL UNIQUE,
  policy_reference text NOT NULL CHECK (char_length(policy_reference) BETWEEN 3 AND 300),
  items_manifest_sha256 char(64) NOT NULL CHECK (items_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  configured_by text NOT NULL,
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text,
  published_at timestamptz,
  CHECK ((status='DRAFT' AND published_by IS NULL AND published_at IS NULL)
    OR (status='PUBLISHED' AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND configured_by <> published_by))
);

CREATE TABLE admissions.document_checklist_items (
  id uuid PRIMARY KEY,
  checklist_id uuid NOT NULL REFERENCES admissions.document_checklists(id),
  requirement_key text NOT NULL CHECK (requirement_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 150),
  document_type_key text NOT NULL CHECK (document_type_key ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  required boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (checklist_id, requirement_key)
);

CREATE TABLE admissions.document_attachments (
  id uuid PRIMARY KEY,
  checklist_item_id uuid NOT NULL REFERENCES admissions.document_checklist_items(id),
  document_id uuid NOT NULL REFERENCES documents.records(id),
  attached_by text NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (checklist_item_id, document_id)
);
CREATE INDEX admission_document_attachments_item_idx
  ON admissions.document_attachments(checklist_item_id, attached_at DESC);

CREATE TABLE admissions.document_verifications (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL UNIQUE REFERENCES admissions.document_attachments(id),
  outcome text NOT NULL CHECK (outcome IN ('VERIFIED','REJECTED')),
  verification_engine text NOT NULL CHECK (verification_engine ~ '^[a-zA-Z0-9_.-]{2,100}$'),
  verification_version text NOT NULL CHECK (verification_version ~ '^[a-zA-Z0-9_.-]{1,100}$'),
  verification_trace jsonb NOT NULL CHECK (jsonb_typeof(verification_trace)='object'),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION admissions.assert_document_evidence_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checklist admissions.document_checklists%ROWTYPE;
  application admissions.applications%ROWTYPE; item admissions.document_checklist_items%ROWTYPE;
  document documents.records%ROWTYPE; document_type documents.types%ROWTYPE;
  attachment admissions.document_attachments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='document_checklist_items' THEN
    SELECT * INTO checklist FROM admissions.document_checklists WHERE id=NEW.checklist_id;
    IF checklist.status <> 'DRAFT' THEN RAISE EXCEPTION 'published admission checklist is immutable'; END IF;
  ELSIF TG_TABLE_NAME='document_attachments' THEN
    SELECT * INTO item FROM admissions.document_checklist_items WHERE id=NEW.checklist_item_id;
    SELECT * INTO checklist FROM admissions.document_checklists WHERE id=item.checklist_id;
    SELECT * INTO application FROM admissions.applications WHERE id=checklist.application_id;
    SELECT * INTO document FROM documents.records WHERE id=NEW.document_id;
    SELECT * INTO document_type FROM documents.types WHERE id=document.document_type_id;
    IF checklist.status <> 'PUBLISHED' OR document.status <> 'CLEAN'
      OR document.owner_subject_id <> application.applicant_subject_id
      OR document.scope_type <> application.scope_type OR document.scope_id <> application.scope_id
      OR document_type.type_key <> item.document_type_key THEN
      RAISE EXCEPTION 'admission attachment does not match its published checklist requirement';
    END IF;
  ELSIF TG_TABLE_NAME='document_verifications' THEN
    SELECT * INTO attachment FROM admissions.document_attachments WHERE id=NEW.attachment_id;
    IF attachment.attached_by=NEW.verified_by THEN
      RAISE EXCEPTION 'document submitter cannot verify the same attachment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION admissions.protect_document_checklist()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'published admission checklist is immutable'; END IF;
  IF NEW.application_id<>OLD.application_id OR NEW.idempotency_key<>OLD.idempotency_key
    OR NEW.policy_reference<>OLD.policy_reference OR NEW.items_manifest_sha256<>OLD.items_manifest_sha256
    OR NEW.configured_by<>OLD.configured_by OR NEW.configured_at<>OLD.configured_at
    OR NEW.status<>'PUBLISHED' OR NEW.version<>OLD.version+1
    OR NEW.published_by IS NULL OR NEW.published_by=OLD.configured_by OR NEW.published_at IS NULL
    OR NOT EXISTS (SELECT 1 FROM admissions.document_checklist_items WHERE checklist_id=OLD.id) THEN
    RAISE EXCEPTION 'invalid admission checklist publication';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER admission_checklist_transition_guard BEFORE UPDATE ON admissions.document_checklists
FOR EACH ROW EXECUTE FUNCTION admissions.protect_document_checklist();
CREATE TRIGGER admission_checklist_no_delete BEFORE DELETE ON admissions.document_checklists
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_checklist_item_consistency BEFORE INSERT ON admissions.document_checklist_items
FOR EACH ROW EXECUTE FUNCTION admissions.assert_document_evidence_consistency();
CREATE TRIGGER admission_checklist_items_no_mutation BEFORE UPDATE OR DELETE ON admissions.document_checklist_items
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_document_attachment_consistency BEFORE INSERT ON admissions.document_attachments
FOR EACH ROW EXECUTE FUNCTION admissions.assert_document_evidence_consistency();
CREATE TRIGGER admission_document_attachments_no_mutation BEFORE UPDATE OR DELETE ON admissions.document_attachments
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
CREATE TRIGGER admission_document_verification_consistency BEFORE INSERT ON admissions.document_verifications
FOR EACH ROW EXECUTE FUNCTION admissions.assert_document_evidence_consistency();
CREATE TRIGGER admission_document_verifications_no_mutation BEFORE UPDATE OR DELETE ON admissions.document_verifications
FOR EACH ROW EXECUTE FUNCTION admissions.reject_evidence_mutation();
