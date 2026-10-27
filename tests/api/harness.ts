// API test harness: the REAL app + REAL PostgreSQL, with a fake Supabase Auth gateway (no network).
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AuthGateway } from '../../src/auth/gateway.js';
import { AppError } from '../../src/utils/errors.js';
import { createUser, pool } from '../db/helpers.js';

export const fakeGateway: AuthGateway = {
  async verifyToken(token) {
    if (!token.startsWith('tok:')) return null;
    const r = await pool.query(
      'select id, email, email_confirmed_at from auth.users where id = $1',
      [token.slice(4)],
    );
    const u = r.rows[0];
    return u ? { id: u.id, email: u.email, emailConfirmed: Boolean(u.email_confirmed_at) } : null;
  },
  async signUp(email) {
    const dup = await pool.query('select 1 from auth.users where lower(email) = lower($1)', [
      email,
    ]);
    if (dup.rowCount)
      throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
    return {
      id: (await pool.query('insert into auth.users (email) values ($1) returning id', [email]))
        .rows[0].id,
    };
  },
  async signIn(email) {
    const r = await pool.query(
      'select id, email_confirmed_at from auth.users where lower(email) = lower($1)',
      [email],
    );
    if (!r.rows[0]) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    if (!r.rows[0].email_confirmed_at)
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email before signing in.');
    return { accessToken: `tok:${r.rows[0].id}`, refreshToken: 'r', expiresAt: null };
  },
  async inviteUser(email) {
    return {
      id: (await pool.query('insert into auth.users (email) values ($1) returning id', [email]))
        .rows[0].id,
    };
  },
  async deleteUser(id) {
    await pool.query('delete from auth.users where id = $1', [id]);
  },
};

export async function makeApp(): Promise<FastifyInstance> {
  return buildApp({
    environment: 'test',
    version: 'test',
    corsOrigins: ['http://localhost:5173'],
    logLevel: 'silent',
    pool,
    gateway: fakeGateway,
    frontendUrl: 'http://localhost:5173',
    checks: { database: async () => undefined, redis: async () => undefined },
  });
}

export const tok = (userId: string) => ({ authorization: `Bearer tok:${userId}` });

export class Client {
  constructor(
    private app: FastifyInstance,
    private userId?: string,
  ) {}
  async call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: this.userId ? tok(this.userId) : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.json() as any, raw: res.body };
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b?: unknown) => this.call('POST', u, b ?? {});
  put = (u: string, b: unknown) => this.call('PUT', u, b);
  patch = (u: string, b: unknown) => this.call('PATCH', u, b);
  del = (u: string) => this.call('DELETE', u);
}
export { createUser };
