import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../exceptions/app.exception.js';
import type { Env } from '../../config/env.schema.js';

/**
 * Hides a route everywhere except NODE_ENV=development. Responds exactly like an unknown route
 * (404) so staging and production don't reveal that the endpoint exists.
 */
@Injectable()
export class DevelopmentOnlyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(): boolean {
    if (this.config.get('NODE_ENV', { infer: true }) !== 'development') {
      throw new AppException('NOT_FOUND', 'Not found', 404);
    }
    return true;
  }
}
