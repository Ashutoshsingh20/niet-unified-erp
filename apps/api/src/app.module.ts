import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { RequestContextModule } from './platform/request-context/request-context.module';
import { AuthModule } from './platform/auth/auth.module';
import { DatabaseModule } from './platform/database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    RequestContextModule,
    AuthModule,
    DatabaseModule,
    HealthModule,
    WorkflowModule,
  ],
})
export class AppModule {}
