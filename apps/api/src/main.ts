import helmet from '@fastify/helmet';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { validateEnvironment, type Environment } from './config/environment';
import { createRequestContextHook } from './platform/request-context/request-context.hook';
import { RequestContextService } from './platform/request-context/request-context.service';

async function bootstrap(): Promise<void> {
  const bootstrapEnvironment = validateEnvironment(process.env);
  const adapter = new FastifyAdapter({
    logger: { level: bootstrapEnvironment.LOG_LEVEL },
    trustProxy: bootstrapEnvironment.TRUST_PROXY,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const config = app.get<ConfigService<Environment, true>>(ConfigService);

  await app.register(helmet, { contentSecurityPolicy: false });
  app.useGlobalPipes(new ValidationPipe({
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  adapter.getInstance().addHook(
    'onRequest',
    createRequestContextHook(app.get(RequestContextService)),
  );

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const openApiConfig = new DocumentBuilder()
      .setTitle('NIET Unified ERP API')
      .setDescription('Versioned API contracts for the NIET Unified ERP platform')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('openapi', app, SwaggerModule.createDocument(app, openApiConfig));
  }

  await app.listen({
    host: config.get('HOST', { infer: true }),
    port: config.get('PORT', { infer: true }),
  });
}

void bootstrap();
