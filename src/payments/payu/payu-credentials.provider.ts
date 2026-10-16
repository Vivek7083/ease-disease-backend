import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { Env } from '../../config/env.schema.js';
import type { PayuConfig } from './payu-client.js';

export interface PayuCredentialsStatus {
  source: 'memory' | 'env' | 'none';
  env: PayuConfig['env'] | null;
  /** Last 4 chars of the key only. The salt is never exposed. */
  keyHint: string | null;
}

/**
 * Single place that answers "which PayU key/salt/env are we using right now?".
 *  - staging/production: only the env vars (Secret Manager injects them in Cloud Run).
 *  - development: credentials loaded via the dev endpoint win, then the env vars.
 * Dev credentials live in this process's memory only: never written to disk, DB or logs.
 */
@Injectable()
export class PayuCredentialsProvider {
  private readonly logger = new Logger(PayuCredentialsProvider.name);
  private override: PayuConfig | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get(): PayuConfig {
    const current = this.resolve();
    if (!current) {
      throw new AppException(
        'PAYMENT_GATEWAY_UNAVAILABLE',
        'Payment gateway is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return current.config;
  }

  status(): PayuCredentialsStatus {
    const current = this.resolve();
    if (!current) return { source: 'none', env: null, keyHint: null };
    return { source: current.source, env: current.config.env, keyHint: hint(current.config.key) };
  }

  setOverride(credentials: PayuConfig): void {
    if (!this.isDevelopment()) {
      throw new AppException('NOT_FOUND', 'Not found', HttpStatus.NOT_FOUND);
    }
    this.override = { ...credentials };
    if (credentials.env === 'live') {
      this.logger.warn('LIVE PayU credentials loaded into memory (development). Transactions will be real.');
    } else {
      this.logger.log('PayU test credentials loaded into memory (development)');
    }
  }

  clearOverride(): void {
    this.override = null;
  }

  private resolve(): { source: 'memory' | 'env'; config: PayuConfig } | null {
    if (this.override && this.isDevelopment()) {
      return { source: 'memory', config: this.override };
    }
    const key = this.config.get('PAYU_KEY', { infer: true });
    const salt = this.config.get('PAYU_SALT', { infer: true });
    if (!key || !salt) return null;
    return { source: 'env', config: { key, salt, env: this.config.get('PAYU_ENV', { infer: true }) ?? 'test' } };
  }

  private isDevelopment(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'development';
  }
}

function hint(key: string): string {
  return key.length >= 8 ? `…${key.slice(-4)}` : '***';
}
