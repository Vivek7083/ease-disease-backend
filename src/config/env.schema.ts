import { z } from 'zod';

/**
 * Validated at boot (see config.module.ts). An invalid/missing env var throws here,
 * so the app never starts in a half-configured state.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
});

export type Env = z.infer<typeof envSchema>;
