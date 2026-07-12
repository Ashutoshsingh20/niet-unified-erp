import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Principal } from '../../platform/auth/auth.types';
import { PolicyService } from '../../platform/auth/policy.service';
import { TransactionalEvidenceService } from '../../platform/evidence/transactional-evidence.service';
import { OBJECT_STORAGE, type ObjectStoragePort, type UploadGrant } from '../../platform/object-storage/object-storage.port';
import type { CreateDocumentTypeDto, InitiateDocumentUploadDto, RecordDocumentScanDto } from './documents.dto';
import type { ActiveDocumentTypeRecord, DocumentRecord } from './documents.types';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly evidence: TransactionalEvidenceService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
  ) {}

  async createType(input: CreateDocumentTypeDto, actor: Principal): Promise<{ id: string }> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO documents.types
          (id, type_key, version, title, status, allowed_mime_types, max_size_bytes,
           classification, retention_days, created_by)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9)`,
        [id, input.typeKey, input.version, input.title, input.allowedMimeTypes,
          input.maxSizeBytes, input.classification, input.retentionDays, actor.subjectId],
      );
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'document.type.created', resourceType: 'document-type', resourceId: id,
        details: { typeKey: input.typeKey, version: input.version } });
    });
    return { id };
  }

  async publishType(id: string, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const draft = await manager.query<readonly { type_key: string }[]>(
        "SELECT type_key FROM documents.types WHERE id = $1 AND status = 'DRAFT' FOR UPDATE", [id]);
      if (draft[0] === undefined) throw new ConflictException('Only a draft document type can be published');
      await manager.query("UPDATE documents.types SET status = 'RETIRED' WHERE type_key = $1 AND status = 'ACTIVE'",
        [draft[0].type_key]);
      await manager.query(
        `UPDATE documents.types SET status = 'ACTIVE', published_by = $2,
         published_at = clock_timestamp() WHERE id = $1`, [id, actor.subjectId]);
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'document.type.published', resourceType: 'document-type', resourceId: id,
        details: { typeKey: draft[0].type_key } });
    });
  }

  async initiateUpload(input: InitiateDocumentUploadDto, actor: Principal): Promise<{ documentId: string; upload: UploadGrant }> {
    validateFilename(input.filename);
    this.policy.assertScope(actor, input.scopeType, input.scopeId);
    const types = await this.dataSource.query<readonly ActiveDocumentTypeRecord[]>(
      `SELECT id, type_key, version, allowed_mime_types, max_size_bytes::text,
              classification, retention_days
       FROM documents.types WHERE type_key = $1 AND status = 'ACTIVE'`, [input.documentTypeKey]);
    const type = types[0];
    if (type === undefined) throw new NotFoundException('Active document type not found');
    if (!type.allowed_mime_types.includes(input.mimeType)) {
      throw new ConflictException('MIME type is not allowed for this document type');
    }
    if (input.sizeBytes > Number(type.max_size_bytes)) {
      throw new ConflictException('Document exceeds the configured size limit');
    }

    const documentId = randomUUID();
    const objectKey = `quarantine/${documentId}`;
    const upload = await this.storage.createQuarantineUpload({ key: objectKey,
      contentType: input.mimeType, sha256: input.sha256, expiresInSeconds: 300 });
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO documents.records
          (id, document_type_id, owner_subject_id, scope_type, scope_id, original_filename,
           declared_mime_type, declared_size_bytes, declared_sha256, quarantine_object_key,
           status, classification, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'UPLOAD_PENDING', $11,
                 clock_timestamp() + ($12::text || ' days')::interval)`,
        [documentId, type.id, actor.subjectId, input.scopeType, input.scopeId, input.filename,
          input.mimeType, input.sizeBytes, input.sha256, objectKey, type.classification,
          type.retention_days],
      );
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'document.upload.initiated', resourceType: 'document', resourceId: documentId,
        details: { documentTypeKey: type.type_key, documentTypeVersion: type.version,
          scopeType: input.scopeType, scopeId: input.scopeId, sizeBytes: input.sizeBytes } });
    });
    return { documentId, upload };
  }

  async completeUpload(id: string, actor: Principal): Promise<void> {
    const record = await this.getRecord(id);
    this.assertOwnerOr(actor, record, 'platform.documents.manage-all');
    if (record.status !== 'UPLOAD_PENDING') throw new ConflictException('Document is not awaiting upload');
    let metadata;
    try {
      metadata = await this.storage.headQuarantineObject(record.quarantine_object_key);
    } catch {
      throw new ConflictException('Uploaded object was not found in quarantine');
    }
    if (metadata.sizeBytes !== Number(record.declared_size_bytes)
      || metadata.contentType !== record.declared_mime_type
      || metadata.sha256 !== record.declared_sha256) {
      throw new ConflictException('Uploaded object metadata does not match the declared file');
    }
    await this.dataSource.transaction(async (manager) => {
      const updated = await manager.query<readonly { id: string }[]>(
        `WITH changed AS (
           UPDATE documents.records SET status = 'QUARANTINED', uploaded_at = clock_timestamp(),
             version = version + 1 WHERE id = $1 AND status = 'UPLOAD_PENDING' AND version = $2
           RETURNING id
         ) SELECT id FROM changed`, [id, record.version]);
      if (updated.length !== 1) throw new ConflictException('Document changed while completing upload');
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'document.upload.completed', resourceType: 'document', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'DocumentScanRequested',
        aggregateType: 'document', aggregateId: id, classification: record.classification,
        payload: { documentId: id, quarantineObjectKey: record.quarantine_object_key } });
    });
  }

  async recordScan(id: string, input: RecordDocumentScanDto, actor: Principal): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const targetStatus = input.outcome === 'CLEAN' ? 'SCAN_PASSED' : 'REJECTED';
      const result = await manager.query<readonly { classification: DocumentRecord['classification'] }[]>(
        `WITH changed AS (
           UPDATE documents.records r
           SET status = $2, scanned_at = clock_timestamp(), scanner_engine = $3,
               scanner_signature_version = $4, detected_mime_type = $5,
               computed_sha256 = $7,
               rejection_reason = CASE WHEN $2 = 'REJECTED' THEN $6 ELSE NULL END,
               version = r.version + 1
           FROM documents.types t
           WHERE r.id = $1 AND r.status = 'QUARANTINED' AND t.id = r.document_type_id
             AND ($2 = 'REJECTED' OR ($7 = r.declared_sha256 AND $5 = ANY(t.allowed_mime_types)))
           RETURNING r.classification
         ) SELECT classification FROM changed`,
        [id, targetStatus, input.scannerEngine, input.signatureVersion,
          input.detectedMimeType, input.reason, input.computedSha256]);
      const scanned = result[0];
      if (scanned === undefined || result.length !== 1) {
        throw new ConflictException('Document is not awaiting a scan result');
      }
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: `document.scan.${input.outcome.toLowerCase()}`, resourceType: 'document', resourceId: id,
        details: { scannerEngine: input.scannerEngine, signatureVersion: input.signatureVersion,
          detectedMimeType: input.detectedMimeType, computedSha256: input.computedSha256,
          reason: input.reason } });
      await this.evidence.outbox(manager, { eventType: input.outcome === 'CLEAN'
        ? 'DocumentPromotionRequested' : 'DocumentRejected', aggregateType: 'document',
        aggregateId: id, classification: scanned.classification,
        payload: { documentId: id } });
    });
  }

  async promote(id: string, actor: Principal): Promise<void> {
    const record = await this.getRecord(id);
    if (record.status !== 'SCAN_PASSED') throw new ConflictException('Document has not passed scanning');
    const cleanKey = `documents/${id}`;
    await this.storage.promoteToClean(record.quarantine_object_key, cleanKey);
    await this.dataSource.transaction(async (manager) => {
      const changed = await manager.query<readonly { id: string }[]>(
        `WITH promoted AS (
           UPDATE documents.records SET status = 'CLEAN', clean_object_key = $2,
             version = version + 1 WHERE id = $1 AND status = 'SCAN_PASSED' AND version = $3
           RETURNING id
         ) SELECT id FROM promoted`, [id, cleanKey, record.version]);
      if (changed.length !== 1) throw new ConflictException('Document changed during promotion');
      await this.evidence.audit(manager, { actorSubjectId: actor.subjectId,
        action: 'document.promoted', resourceType: 'document', resourceId: id });
      await this.evidence.outbox(manager, { eventType: 'DocumentAccepted',
        aggregateType: 'document', aggregateId: id, classification: record.classification,
        payload: { documentId: id } });
    });
  }

  async createDownload(id: string, actor: Principal): Promise<{ url: string; expiresAt: string }> {
    const record = await this.getRecord(id);
    this.assertOwnerOr(actor, record, 'platform.documents.read-all');
    if (record.status !== 'CLEAN' || record.clean_object_key === null) {
      throw new ConflictException('Document is not available for download');
    }
    const expiresInSeconds = 60;
    return { url: await this.storage.createCleanDownload(record.clean_object_key,
      record.original_filename, expiresInSeconds),
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }

  private async getRecord(id: string): Promise<DocumentRecord> {
    const records = await this.dataSource.query<readonly DocumentRecord[]>(
      `SELECT id, owner_subject_id, scope_type, scope_id, original_filename, declared_mime_type,
              declared_size_bytes::text, declared_sha256, quarantine_object_key, clean_object_key,
              status, classification, version
       FROM documents.records WHERE id = $1`, [id]);
    if (records[0] === undefined) throw new NotFoundException('Document not found');
    return records[0];
  }

  private assertOwnerOr(actor: Principal, record: DocumentRecord, permission: string): void {
    if (record.owner_subject_id === actor.subjectId) return;
    if (!actor.permissions.has(permission)) throw new ForbiddenException('Document access is not permitted');
    this.policy.assertScope(actor, record.scope_type, record.scope_id);
  }
}

export function validateFilename(filename: string): void {
  if (filename.trim() !== filename || filename.includes('/') || filename.includes('\\')
    || [...filename].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
    throw new ConflictException('Filename contains unsafe characters');
  }
}
