import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Tells Express how many reverse proxies sit in front of the app, so `req.ip` is the real client and
 * not the proxy. With 0 the `X-Forwarded-For` header is ignored completely, so it cannot be forged
 * to hide or fake an address. The right non-zero number is a deployment fact (Cloud Run / load balancer).
 */
export function configureTrustProxy(app: NestExpressApplication, hops: number): void {
  app.set('trust proxy', hops);
}
