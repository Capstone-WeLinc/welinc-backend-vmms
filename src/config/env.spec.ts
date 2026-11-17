import { validateEnv } from './env';

const baseEnv = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://portal.example.com,https://web.example.com',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/vmms',
  AUTH_ISSUER: 'https://auth.example.com/auth',
  AUTH_JWKS_URL: 'https://auth.example.com/auth/.well-known/jwks.json',
  AUTH_INTERNAL_URL: 'https://auth.internal.example.com',
  AUTH_CLIENT_ID: 'vmms',
  AUTH_CLIENT_PRIVATE_KEY: 'test-key',
  WEB_APP_URL: 'https://web.example.com',
  PORTAL_URL: 'https://portal.example.com',
  AUTH_PUBLIC_URL: 'https://auth.example.com',
  API_PUBLIC_URL: 'https://api.example.com',
};

describe('production URL validation', () => {
  it('accepts secure production URLs', () => {
    expect(validateEnv(baseEnv).NODE_ENV).toBe('production');
  });

  it.each([
    ['http protocol', { ...baseEnv, WEB_APP_URL: 'http://web.example.com' }],
    [
      'localhost hostname',
      { ...baseEnv, AUTH_JWKS_URL: 'https://localhost:3001/jwks' },
    ],
    [
      'localhost CORS origin',
      {
        ...baseEnv,
        CORS_ORIGINS: 'https://portal.example.com,http://localhost:8000',
      },
    ],
    [
      'loopback address',
      { ...baseEnv, API_PUBLIC_URL: 'https://127.0.0.1:3010' },
    ],
  ])('rejects %s', (_case, env) => {
    expect(() => validateEnv(env)).toThrow(
      /must (use https|not point at localhost) in production/,
    );
  });

  it('allows HTTP container-to-container URLs in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        AUTH_INTERNAL_URL: 'http://auth-service:3001',
      }),
    ).not.toThrow();
  });

  it('continues to allow local HTTP URLs outside production', () => {
    expect(
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'development',
        WEB_APP_URL: 'http://localhost:8002',
      }).NODE_ENV,
    ).toBe('development');
  });
});
