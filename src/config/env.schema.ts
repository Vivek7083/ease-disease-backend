import { z } from 'zod';

/** An http(s) origin only (no path, query, hash or credentials), normalised without a trailing slash. */
const originUrl = () =>
  z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must be an http(s) URL')
    .refine((value) => {
      const url = new URL(value);
      return url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
    }, 'must be an origin only (no path, query, hash or credentials)')
    .transform((value) => new URL(value).origin);

/**
 * Validated at boot (see config.module.ts). An invalid/missing env var throws here,
 * so the app never starts in a half-configured state.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    /** Which PayU environment to talk to. Defaults to the safe one. */
    PAYU_ENV: z.enum(['test', 'live']).default('test'),
    PAYU_KEY: z.string().min(1).optional(),
    PAYU_SALT: z.string().min(1).optional(),
    /** Where PayU's browser callback sends the user. An origin only; the path is always ours. */
    FRONTEND_BASE_URL: originUrl().optional(),
    /**
     * Public address of THIS API, used for the success/failure/cancel URLs PayU sends the browser back to.
     * PayU's hosted-checkout docs require a public https URL, so outside development it must be https.
     */
    API_PUBLIC_URL: originUrl().optional(),
    /** Number of trusted reverse proxies in front of the app, so `req.ip` is the real client. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((env, ctx) => {
    // Payments must never boot half-configured outside local dev/test.
    if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
      for (const name of ['PAYU_KEY', 'PAYU_SALT'] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required when NODE_ENV is ${env.NODE_ENV}` });
        }
      }
    }
    if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
      for (const name of ['FRONTEND_BASE_URL', 'API_PUBLIC_URL'] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required when NODE_ENV is ${env.NODE_ENV}` });
        } else if (!env[name].startsWith('https://')) {
          ctx.addIssue({ code: 'custom', path: [name], message: `${name} must use https outside development` });
        }
      }
    }
    // Live PayU is production-only, so a staging/dev box can't take real money by misconfiguration.
    if (env.PAYU_ENV === 'live' && env.NODE_ENV !== 'production') {
      ctx.addIssue({ code: 'custom', path: ['PAYU_ENV'], message: 'PAYU_ENV=live is only allowed when NODE_ENV is production' });
    }
  });

export type Env = z.infer<typeof envSchema>;
