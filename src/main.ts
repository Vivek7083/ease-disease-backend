import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { setupSwaggerIfAllowed } from './swagger.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new AllExceptionsFilter());

  const configService = app.get(ConfigService<Env, true>);
  setupSwaggerIfAllowed(app, configService.get('NODE_ENV', { infer: true }));

  await app.listen(configService.get('PORT', { infer: true }));
}
await bootstrap();
