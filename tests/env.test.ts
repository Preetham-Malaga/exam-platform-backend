import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const valid = {
  NODE_ENV: 'development',
  PORT: '4000',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
};

describe('parseEnv', () => {
  it('parses a valid configuration and splits CORS origins', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('rejects missing variables and names them', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('never echoes secret values in the error message', () => {
    try {
      parseEnv({ ...valid, SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: '' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('not-a-url');
    }
  });
});
