export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface UploadGrant {
  readonly url: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface StoredObjectMetadata {
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly sha256?: string;
}

export interface ObjectStoragePort {
  createQuarantineUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly expiresInSeconds: number;
  }): Promise<UploadGrant>;
  headQuarantineObject(key: string): Promise<StoredObjectMetadata>;
  promoteToClean(quarantineKey: string, cleanKey: string): Promise<void>;
  createCleanDownload(key: string, filename: string, expiresInSeconds: number): Promise<string>;
}

