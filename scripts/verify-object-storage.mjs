import { createHash, randomUUID } from 'node:crypto';
import { MinioObjectStorageAdapter } from '../apps/api/dist/platform/object-storage/minio-object-storage.adapter.js';

const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY;
const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY;
if (endpoint === undefined || accessKey === undefined || secretKey === undefined) {
  throw new Error('OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY are required');
}

const values = {
  OBJECT_STORAGE_ENDPOINT: endpoint,
  OBJECT_STORAGE_REGION: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
  OBJECT_STORAGE_ACCESS_KEY: accessKey,
  OBJECT_STORAGE_SECRET_KEY: secretKey,
  OBJECT_STORAGE_QUARANTINE_BUCKET: process.env.OBJECT_STORAGE_QUARANTINE_BUCKET ?? 'niet-erp-quarantine',
  OBJECT_STORAGE_CLEAN_BUCKET: process.env.OBJECT_STORAGE_CLEAN_BUCKET ?? 'niet-erp-documents',
};
const config = { get(key) { return values[key]; } };
const storage = new MinioObjectStorageAdapter(config);
const content = new TextEncoder().encode(`NIET object storage verification ${randomUUID()}`);
const sha256 = createHash('sha256').update(content).digest('hex');
const id = randomUUID();
const quarantineKey = `verification/${id}`;
const cleanKey = `verification-clean/${id}`;
const upload = await storage.createQuarantineUpload({ key: quarantineKey,
  contentType: 'text/plain', sha256, expiresInSeconds: 60 });
const uploadResponse = await fetch(upload.url, {
  method: 'PUT',
  headers: upload.requiredHeaders,
  body: content,
});
if (!uploadResponse.ok) {
  throw new Error(`Presigned upload failed with ${uploadResponse.status}: ${await uploadResponse.text()}`);
}
const metadata = await storage.headQuarantineObject(quarantineKey);
if (metadata.sizeBytes !== content.byteLength || metadata.contentType !== 'text/plain'
  || metadata.sha256 !== sha256) {
  throw new Error('Stored quarantine metadata does not match the uploaded object');
}
await storage.promoteToClean(quarantineKey, cleanKey);
const downloadUrl = await storage.createCleanDownload(cleanKey, 'verification.txt', 60);
const downloadResponse = await fetch(downloadUrl);
if (!downloadResponse.ok) throw new Error(`Presigned download failed with ${downloadResponse.status}`);
const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
if (createHash('sha256').update(downloaded).digest('hex') !== sha256) {
  throw new Error('Downloaded clean object does not match the uploaded bytes');
}
process.stdout.write('MinIO presigned upload, metadata, promotion, and download verified\n');
