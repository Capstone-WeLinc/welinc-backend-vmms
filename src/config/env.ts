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
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: integer(3010, 1, 65535),
  TRUST_PROXY_HOPS: integer(0, 0, 10),
  CORS_ORIGINS: required.transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
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
  STORAGE_CONTAINER: z.preprocess(
    blank,
    z.string().trim().min(1).default('vmms-uploads'),
  ),
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: z.preprocess(
    blank,
    z.url({ protocol: /^https$/ }).optional(),
  ),
  AZURE_DOCUMENT_INTELLIGENCE_KEY: z.preprocess(
    blank,
    z.string().trim().optional(),
  ),
});

const productionUrlNames = [
  'AUTH_JWKS_URL',
  'AUTH_INTERNAL_URL',
  'WEB_APP_URL',
  'API_PUBLIC_URL',
  'PORTAL_URL',
  'AUTH_PUBLIC_URL',
  'STORAGE_ACCOUNT_URL',
  'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT',
] as const;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function productionUrlProblem(value: string, name: string): string | null {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  const isContainerAuthUrl =
    name === 'AUTH_INTERNAL_URL' &&
    parsed.hostname !== 'localhost' &&
    !parsed.hostname.includes('.');
  if (parsed.protocol !== 'https:' && !isContainerAuthUrl)
    return 'must use https in production';
  if (localHosts.has(parsed.hostname))
    return 'must not point at localhost in production';
  return null;
}

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${String(issue.path[0])}: ${issue.message}`,
    );
    const productionDetails = productionUrlIssues(raw);
    throw new Error(
      `Environment check failed:\n  ${[...details, ...productionDetails].join('\n  ')}`,
    );
  }
  if (
    parsed.data.AZURE_DOCUMENT_INTELLIGENCE_KEY &&
    !parsed.data.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
  ) {
    throw new Error(
      'Environment check failed:\n  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT is required when AZURE_DOCUMENT_INTELLIGENCE_KEY is configured',
    );
  }
  const productionDetails = productionUrlIssues(raw);
  if (productionDetails.length) {
    throw new Error(
      `Environment check failed:\n  ${productionDetails.join('\n  ')}`,
    );
  }
  return parsed.data;
}

function productionUrlIssues(raw: Record<string, unknown>): string[] {
  if (raw.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  for (const name of productionUrlNames) {
    const value = raw[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    const problem = productionUrlProblem(value.trim(), name);
    if (problem) issues.push(`${name}: ${problem}`);
  }
  const origins =
    typeof raw.CORS_ORIGINS === 'string' ? raw.CORS_ORIGINS.split(',') : [];
  for (const origin of origins.map((value) => value.trim()).filter(Boolean)) {
    const problem = productionUrlProblem(origin, 'CORS_ORIGINS');
    if (problem) {
      issues.push(`CORS_ORIGINS: each entry ${problem}`);
      break;
    }
  }
  return issues;
}
