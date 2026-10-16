import { z } from 'zod';

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
    // Live PayU is production-only, so a staging/dev box can't take real money by misconfiguration.
    if (env.PAYU_ENV === 'live' && env.NODE_ENV !== 'production') {
      ctx.addIssue({ code: 'custom', path: ['PAYU_ENV'], message: 'PAYU_ENV=live is only allowed when NODE_ENV is production' });
    }
  });

export type Env = z.infer<typeof envSchema>;
