import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { RequestContextModule } from './platform/request-context/request-context.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    RequestContextModule,
    HealthModule,
  ],
})
export class AppModule {}

