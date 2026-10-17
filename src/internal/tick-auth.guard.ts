import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { AppException } from '../common/exceptions/app.exception.js';
import { OIDC_VERIFIER, type OidcVerifier } from './oidc-verifier.js';

const MAX_AUTHORIZATION_CHARS = 4096;
const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * Only Cloud Scheduler's service account may call the internal tick. Requires a Google-signed OIDC ID token whose
 * audience is TICK_AUDIENCE and whose verified email is TICK_SERVICE_ACCOUNT_EMAIL. Fails closed: when unconfigured,
 * or on any doubt, the answer is the same 401 whatever the reason (the reason goes to the log, never to the caller),
 * and nothing behind the guard runs.
 */
@Injectable()
export class TickAuthGuard implements CanActivate {
  private readonly logger = new Logger(TickAuthGuard.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(OIDC_VERIFIER) private readonly verifier: OidcVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const audience = this.config.get('TICK_AUDIENCE', { infer: true });
    const expectedEmail = this.config.get('TICK_SERVICE_ACCOUNT_EMAIL', { infer: true })?.toLowerCase();
    if (!audience || !expectedEmail) return this.deny('tick authentication is not configured');

    const header = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers['authorization'];
    if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_CHARS) return this.deny('missing or oversized Authorization header');
    const token = BEARER_JWT.exec(header)?.[1];
    if (!token) return this.deny('Authorization header is not a Bearer JWT');

    let claims;
    try {
      claims = await this.verifier.verify(token, audience);
    } catch (error) {
      return this.deny(`token verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!claims.emailVerified) return this.deny('token email is not verified');
    if (claims.email?.toLowerCase() !== expectedEmail) return this.deny('token was issued to a different account');
    return true;
  }

  private deny(reason: string): never {
    this.logger.warn(`Tick request rejected: ${reason}`);
    throw new AppException('UNAUTHENTICATED', 'Authentication required', 401);
  }
}
