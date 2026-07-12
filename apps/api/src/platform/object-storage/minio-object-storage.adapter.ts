import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment';
import type { ObjectStoragePort, StoredObjectMetadata, UploadGrant } from './object-storage.port';

@Injectable()
export class MinioObjectStorageAdapter implements ObjectStoragePort {
  private readonly client: S3Client;
  private readonly quarantineBucket: string;
  private readonly cleanBucket: string;

  constructor(config: ConfigService<Environment, true>) {
    this.quarantineBucket = config.get('OBJECT_STORAGE_QUARANTINE_BUCKET', { infer: true });
    this.cleanBucket = config.get('OBJECT_STORAGE_CLEAN_BUCKET', { infer: true });
    this.client = new S3Client({
      endpoint: config.get('OBJECT_STORAGE_ENDPOINT', { infer: true }),
      region: config.get('OBJECT_STORAGE_REGION', { infer: true }),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get('OBJECT_STORAGE_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('OBJECT_STORAGE_SECRET_KEY', { infer: true }),
      },
    });
  }

  async createQuarantineUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly expiresInSeconds: number;
  }): Promise<UploadGrant> {
    const command = new PutObjectCommand({
      Bucket: this.quarantineBucket,
      Key: input.key,
      ContentType: input.contentType,
      Metadata: { sha256: input.sha256 },
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
    return {
      url,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      requiredHeaders: {
        'content-type': input.contentType,
      },
    };
  }

  async headQuarantineObject(key: string): Promise<StoredObjectMetadata> {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.quarantineBucket,
      Key: key,
    }));
    return {
      sizeBytes: result.ContentLength ?? -1,
      ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
      ...(result.Metadata?.sha256 === undefined ? {} : { sha256: result.Metadata.sha256 }),
    };
  }

  async promoteToClean(quarantineKey: string, cleanKey: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.cleanBucket,
      Key: cleanKey,
      CopySource: encodeURIComponent(`${this.quarantineBucket}/${quarantineKey}`).replaceAll('%2F', '/'),
      MetadataDirective: 'COPY',
    }));
  }

  async createCleanDownload(key: string, filename: string, expiresInSeconds: number): Promise<string> {
    const safeFilename = filename.replaceAll(/["\\\r\n]/g, '_');
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.cleanBucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
    }), { expiresIn: expiresInSeconds });
  }
}
