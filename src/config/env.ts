// PURPOSE: Validates and exposes environment variables with Zod.
// WHY: The server must refuse to start with missing or malformed configuration (fail fast).
// DEPENDS ON: process.env. Used by server.ts and app.ts.

import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  DATABASE_URL: nonEmpty,
  REDIS_URL: nonEmpty,
  CORS_ORIGINS: nonEmpty.transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
});

export type Env = z.infer<typeof envSchema>;

/** Parses raw variables. Error text lists variable NAMES only, never their values. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
