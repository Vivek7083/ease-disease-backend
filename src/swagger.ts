import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const SWAGGER_PATH = 'docs';

/**
 * Swagger is a debugging/exploration aid for development and staging only. It must never be
 * reachable in production: it would expose the full route/DTO surface (including internal-only
 * endpoints like /v1/internal/tick) to anyone who finds the URL. Gated on NODE_ENV, not on a
 * feature flag, so there's no way to accidentally leave it on via config.
 */
export function setupSwaggerIfAllowed(app: INestApplication, nodeEnv: string): void {
  if (nodeEnv === 'production') {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('Ease Disease API')
    .setDescription(`API docs (${nodeEnv}) — never deployed to production. See api-flow.md for the locked contract.`)
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'firebase-id-token')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
}
