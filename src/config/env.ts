import { z } from 'zod';

const blank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const required = z.preprocess(blank, z.string().trim().min(1, 'is required'));
const url = required.pipe(z.url({ protocol: /^https?$/ }));
const integer = (fallback: number, min: number, max: number) =>
  z.preprocess(
    blank,
    z.coerce.number().int().min(min).max(max).default(fallback),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: integer(3010, 1, 65535),
  TRUST_PROXY_HOPS: integer(0, 0, 10),
  CORS_ORIGINS: required.transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean),
  ),
  DATABASE_URL: required,
  AUTH_ISSUER: required,
  AUTH_JWKS_URL: url,
  AUTH_INTERNAL_URL: url,
  AUTH_CLIENT_ID: required,
  AUTH_CLIENT_PRIVATE_KEY: required,
  WEB_APP_URL: url,
  PORTAL_URL: url,
  AUTH_PUBLIC_URL: url,
  API_PUBLIC_URL: url,
  SESSION_COOKIE_SECURE: z
    .preprocess(blank, z.enum(['true', 'false']).default('false'))
    .transform((value) => value === 'true'),
  STORAGE_CONNECTION_STRING: z.preprocess(blank, z.string().trim().optional()),
  STORAGE_ACCOUNT_URL: z.preprocess(blank, z.string().trim().url().optional()),
  STORAGE_CONTAINER: z.preprocess(blank, z.string().trim().min(1).default('vmms-uploads')),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    throw new Error(`Environment check failed:\n  ${details.join('\n  ')}`);
  }
  return parsed.data;
}
