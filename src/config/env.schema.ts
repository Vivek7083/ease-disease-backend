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
 * A Firebase project id is a Google Cloud project id: 6-30 characters, lower-case letters, digits and hyphens,
 * starting with a letter and not ending with a hyphen. It is the audience every sign-in token must carry, so a
 * typo must stop the boot rather than reject every login later. A blank value counts as "not set".
 */
const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/** `host:port` as the Firebase SDK reads it from FIREBASE_AUTH_EMULATOR_HOST: no scheme, IPv6 in brackets. */
const EMULATOR_HOST_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/;
const isEmulatorHost = (value: string) => {
  const port = EMULATOR_HOST_PATTERN.exec(value)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65535;
};

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
    /**
     * A business-owned Indian mobile number (ten digits, optionally written +91...), sent to PayU as the customer phone when the
     * booking's WhatsApp number is from another country. Optional; without it such bookings cannot be paid yet.
     */
    PAYU_FALLBACK_PHONE: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .regex(/^(?:\+91)?[6-9]\d{9}$/, 'must be an Indian mobile number: ten digits starting 6-9, optionally written +91...')
        .transform((value) => value.slice(-10))
        .optional(),
    ),
    /** Where PayU's browser callback sends the user. An origin only; the path is always ours. */
    FRONTEND_BASE_URL: originUrl().optional(),
    /**
     * Public address of THIS API, used for the success/failure/cancel URLs PayU sends the browser back to.
     * PayU's hosted-checkout docs require a public https URL, so outside development it must be https.
     */
    API_PUBLIC_URL: originUrl().optional(),
    /**
     * Cloud Scheduler's OIDC token must carry exactly this audience (the API address it calls) and come from exactly
     * this service account. Both are required outside development; if either is missing the tick endpoint rejects everyone.
     */
    TICK_AUDIENCE: z.url().optional(),
    TICK_SERVICE_ACCOUNT_EMAIL: z
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    /** Number of trusted reverse proxies in front of the app, so `req.ip` is the real client. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /** The Firebase project whose sign-in tokens we accept. Required in staging and production. */
    FIREBASE_PROJECT_ID: z.preprocess(
      blankToUndefined,
      z.string().trim().regex(FIREBASE_PROJECT_ID_PATTERN, 'must be a Firebase project id (6-30 chars: lower-case letters, digits, hyphens; starts with a letter)').optional(),
    ),
    /**
     * `enforce` rejects protected calls without a valid App Check token. `off` exists only for local development and
     * tests (a local frontend has no production reCAPTCHA key); the default is the safe state.
     */
    APP_CHECK_MODE: z.enum(['enforce', 'off']).default('enforce'),
    /**
     * Local Firebase Auth emulator address. With this set, the Admin SDK skips signature checks and trusts whatever
     * answers at that address, so it may only exist in development and test. Kept raw (not trimmed or dropped when
     * blank) so that its mere presence can be refused in a deployed environment.
     */
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
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
    // The reconcile tick is authenticated by Google-signed tokens: never boot without knowing whose.
    if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
      for (const name of ['TICK_AUDIENCE', 'TICK_SERVICE_ACCOUNT_EMAIL'] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required when NODE_ENV is ${env.NODE_ENV}` });
        }
      }
      if (env.TICK_AUDIENCE && !env.TICK_AUDIENCE.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['TICK_AUDIENCE'], message: 'TICK_AUDIENCE must use https outside development' });
      }
    } else if (Boolean(env.TICK_AUDIENCE) !== Boolean(env.TICK_SERVICE_ACCOUNT_EMAIL)) {
      const missing = env.TICK_AUDIENCE ? 'TICK_SERVICE_ACCOUNT_EMAIL' : 'TICK_AUDIENCE';
      ctx.addIssue({ code: 'custom', path: [missing], message: 'TICK_AUDIENCE and TICK_SERVICE_ACCOUNT_EMAIL must be set together' });
    }
    // Sign-in: a deployed environment must know its Firebase project, must enforce App Check, and must not be in emulator mode.
    const deployed = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
    if (deployed && !env.FIREBASE_PROJECT_ID) {
      ctx.addIssue({ code: 'custom', path: ['FIREBASE_PROJECT_ID'], message: `FIREBASE_PROJECT_ID is required when NODE_ENV is ${env.NODE_ENV}` });
    }
    if (deployed && env.APP_CHECK_MODE === 'off') {
      ctx.addIssue({ code: 'custom', path: ['APP_CHECK_MODE'], message: `APP_CHECK_MODE=off is not allowed when NODE_ENV is ${env.NODE_ENV}` });
    }
    if (env.FIREBASE_AUTH_EMULATOR_HOST !== undefined) {
      if (deployed) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIREBASE_AUTH_EMULATOR_HOST'],
          message: `FIREBASE_AUTH_EMULATOR_HOST must not be set when NODE_ENV is ${env.NODE_ENV} (it switches off token signature checks)`,
        });
      } else if (env.FIREBASE_AUTH_EMULATOR_HOST !== '' && !isEmulatorHost(env.FIREBASE_AUTH_EMULATOR_HOST)) {
        ctx.addIssue({ code: 'custom', path: ['FIREBASE_AUTH_EMULATOR_HOST'], message: 'FIREBASE_AUTH_EMULATOR_HOST must be host:port, e.g. localhost:9099' });
      }
    }
    // Live PayU is production-only, so a staging/dev box can't take real money by misconfiguration.
    if (env.PAYU_ENV === 'live' && env.NODE_ENV !== 'production') {
      ctx.addIssue({ code: 'custom', path: ['PAYU_ENV'], message: 'PAYU_ENV=live is only allowed when NODE_ENV is production' });
    }
  });

export type Env = z.infer<typeof envSchema>;
