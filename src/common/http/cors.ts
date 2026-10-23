import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

/** The Angular dev server; allowed only when NODE_ENV is development so a deployed API never trusts localhost. */
const DEVELOPMENT_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

export type CorsSettings = {
  nodeEnv: string;
  frontendBaseUrl?: string;
  extraOrigins?: readonly string[];
};

/**
 * Browser access rules: an exact list of origins (never `*`, never reflecting the caller's origin), the headers our
 * routes use, and no cookies (the API authenticates by bearer token). A request from any other origin simply gets no
 * CORS headers and the browser blocks it.
 */
export function corsOptions(settings: CorsSettings): CorsOptions {
  const allowed = new Set<string>([
    ...(settings.frontendBaseUrl ? [settings.frontendBaseUrl] : []),
    ...(settings.extraOrigins ?? []),
    ...(settings.nodeEnv === 'development' ? DEVELOPMENT_ORIGINS : []),
  ]);
  return {
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Firebase-AppCheck'],
    exposedHeaders: ['Retry-After', 'Idempotent-Replayed', 'X-Request-Id'],
    credentials: false,
    maxAge: 600,
  };
}
