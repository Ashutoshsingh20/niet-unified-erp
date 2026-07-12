import type { DataClassification } from '../../platform/evidence/transactional-evidence.service';

export interface ActiveDocumentTypeRecord {
  readonly id: string;
  readonly type_key: string;
  readonly version: number;
  readonly allowed_mime_types: readonly string[];
  readonly max_size_bytes: string;
  readonly classification: DataClassification;
  readonly retention_days: number;
}

export interface DocumentRecord {
  readonly id: string;
  readonly owner_subject_id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly original_filename: string;
  readonly declared_mime_type: string;
  readonly declared_size_bytes: string;
  readonly declared_sha256: string;
  readonly quarantine_object_key: string;
  readonly clean_object_key: string | null;
  readonly status: 'UPLOAD_PENDING' | 'QUARANTINED' | 'SCAN_PASSED' | 'CLEAN' | 'REJECTED' | 'DELETED';
  readonly classification: DataClassification;
  readonly version: number;
}

