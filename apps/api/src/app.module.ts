import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { RequestContextModule } from './platform/request-context/request-context.module';
import { AuthModule } from './platform/auth/auth.module';
import { DatabaseModule } from './platform/database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { EvidenceModule } from './platform/evidence/evidence.module';
import { AccessModule } from './modules/access/access.module';
import { ObjectStorageModule } from './platform/object-storage/object-storage.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SearchModule } from './modules/search/search.module';
import { SearchPlatformModule } from './platform/search/search-platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    RequestContextModule,
    AuthModule,
    DatabaseModule,
    EvidenceModule,
    ObjectStorageModule,
    SearchPlatformModule,
    HealthModule,
    WorkflowModule,
    AccessModule,
    DocumentsModule,
    NotificationsModule,
    SearchModule,
  ],
})
export class AppModule {}
