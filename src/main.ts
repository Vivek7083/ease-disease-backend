import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { corsOptions } from './common/http/cors.js';
import { configureTrustProxy } from './common/http/trust-proxy.js';
import { setupSwaggerIfAllowed } from './swagger.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalFilters(new AllExceptionsFilter());

  const configService = app.get(ConfigService<Env, true>);
  configureTrustProxy(app, configService.get('TRUST_PROXY_HOPS', { infer: true }));
  app.enableCors(
    corsOptions({
      nodeEnv: configService.get('NODE_ENV', { infer: true }),
      frontendBaseUrl: configService.get('FRONTEND_BASE_URL', { infer: true }),
      extraOrigins: configService.get('CORS_EXTRA_ORIGINS', { infer: true }),
    }),
  );
  setupSwaggerIfAllowed(app, configService.get('NODE_ENV', { infer: true }));

  await app.listen(configService.get('PORT', { infer: true }));
}
await bootstrap();
