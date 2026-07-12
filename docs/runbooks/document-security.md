# Document security runbook

## Security model

All user uploads enter a dedicated quarantine bucket under an unguessable object key. Quarantine objects are never downloadable through the ERP. A document becomes available only after an authorized scanner reports both a clean malware result and evidence derived from the actual bytes:

- computed SHA-256 equals the hash declared before upload;
- detected MIME signature is allowed by the effective document-type version;
- scanner engine and signature version are recorded;
- clean promotion completes into the separate document bucket.

User-supplied object metadata is checked at upload completion but is not treated as proof of byte integrity. The scanner-computed hash is authoritative for acceptance.

## Document-type configuration

Document types are versioned and begin in `DRAFT`. An authorized administrator configures the MIME allowlist, maximum size, classification, and retention duration, then publishes the version with step-up authentication. Publishing retires the previous active version. Existing documents remain bound to their historical version.

Retention values are configuration placeholders until NIET resolves decision D-03. Production document types must not be published without data-owner approval.

## Upload and scan sequence

1. Client requests an upload grant with filename, MIME, byte size, SHA-256, and authorized scope.
2. API validates the active document type and creates an `UPLOAD_PENDING` record.
3. Client uploads directly to the quarantine bucket using the five-minute signed URL and exact required headers.
4. Client completes the upload. API checks object size, content type, and signed checksum metadata and changes the state to `QUARANTINED`.
5. `DocumentScanRequested` is published through the transactional outbox.
6. The isolated scanner downloads from quarantine, performs malware and file-signature inspection, computes SHA-256, and submits its result using a scanner-only identity.
7. A valid clean result changes state to `SCAN_PASSED` and emits `DocumentPromotionRequested`. A rejected result remains isolated and is never downloadable.
8. The promotion worker copies the object to the clean bucket. The database then changes to `CLEAN` and emits `DocumentAccepted`.
9. Authorized downloads use a one-minute signed URL. The application re-authorizes ownership or scoped elevated access before every grant.

The quarantine source is retained after copy until a separate audited cleanup process confirms the clean record. This makes promotion retryable if the database update fails after object copying.

## Bucket controls

- No anonymous bucket policy.
- Quarantine credentials can write and scan but cannot provide user downloads.
- Clean-download credentials cannot read quarantine.
- Enable versioning, server-side encryption, object-lock/retention where approved, access logging, replication, and capacity alerts.
- Mirror approved MinIO images into Harbor and pin by digest.
- Never expose MinIO API or console directly to the internet.

## Verification

Application and database flow:

```bash
npm run build --workspace @niet/api
DATABASE_URL='postgresql://.../niet_erp_test' npm run documents:verify
```

Real MinIO adapter:

```bash
OBJECT_STORAGE_ENDPOINT='http://127.0.0.1:9000' \
OBJECT_STORAGE_ACCESS_KEY='test-access-key' \
OBJECT_STORAGE_SECRET_KEY='test-secret-key' \
npm run object-storage:verify
```

The production gate additionally requires malware samples in an isolated security test environment, malformed/polyglot files, decompression bombs, MIME mismatch, interrupted promotion, bucket outage, scanner outage, and retention-cleanup tests.

