import { Global, Module } from '@nestjs/common';
import { MinioObjectStorageAdapter } from './minio-object-storage.adapter';
import { OBJECT_STORAGE } from './object-storage.port';

@Global()
@Module({
  providers: [MinioObjectStorageAdapter, {
    provide: OBJECT_STORAGE,
    useExisting: MinioObjectStorageAdapter,
  }],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}

