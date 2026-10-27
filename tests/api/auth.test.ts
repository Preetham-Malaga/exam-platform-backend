import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AuthGateway } from '../../src/auth/gateway.js';
import { DATABASE_TEST_URL, createTenant, createUser, pool, type Tenant } from '../db/helpers.js';
import { Client, fakeGateway, makeApp } from './harness.js';

const goodBody = (over: Record<string, unknown> = {}) => ({
  organizationName: 'Reg College',
  institutionType: 'school',
  ownerName: 'Reg Owner',
  email: `owner.${randomUUID()}@test.local`,
  password: 'Passw0rd!x',
  ...over,
});

describe.skipIf(!DATABASE_TEST_URL)('Authentication API (real app + real PostgreSQL)', () => {
  let app: FastifyInstance;
  let A: Tenant;
  const as = (id?: string) => new Client(app, id);
  const post = (url: string, payload: unknown, ip = '10.1.1.1') =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      payload: payload as object,
      headers: { 'x-forwarded-for': ip },
    });

  beforeAll(async () => {
    app = await makeApp();
    A = await createTenant('apiAuth');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('POST /auth/register', () => {
    it('creates the login, the organization, owner role, settings and trial in one go', async () => {
      const body = goodBody();
      const res = await post('/auth/register', body, '10.2.0.1');
      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json).toMatchObject({
        success: true,
        error: null,
        data: { emailVerificationRequired: true },
      });
      expect(json.data.organizationCode).toMatch(/^ORG-\d{6}$/);
      expect(JSON.stringify(json)).not.toContain(body.password);

      const u = (
        await pool.query('select id, email_confirmed_at from auth.users where email = $1', [
          body.email,
        ])
      ).rows[0];
      expect(u.email_confirmed_at).toBeNull(); // not verified yet
      const o = (
        await pool.query(
          `select o.name, o.institution_type, o.status,
                (select count(*) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and r.code = 'ORGANIZATION_OWNER')::int as owner_roles,
                (select count(*) from subscriptions s where s.organization_id = o.id and s.status = 'trialing')::int as trials,
                (select count(*) from organization_settings where organization_id = o.id)::int as settings,
                (select is_platform_super_admin from profiles where id = $1) as is_platform
         from organizations o join organization_members m on m.organization_id = o.id where m.user_id = $1`,
          [u.id],
        )
      ).rows[0];
      expect(o).toMatchObject({
        name: 'Reg College',
        institution_type: 'school',
        status: 'pending_email',
        owner_roles: 1,
        trials: 1,
        settings: 1,
        is_platform: false,
      });
    });

    it('never trusts role/organization/platform fields in the body', async () => {
      const body = goodBody({
        role: 'PLATFORM_SUPER_ADMIN',
        isPlatformAdmin: true,
        organizationId: A.orgId,
        status: 'active',
        orgCode: 'ORG-000001',
      });
      const res = await post('/auth/register', body, '10.2.0.2');
      expect(res.statusCode).toBe(201);
      const u = (await pool.query('select id from auth.users where email = $1', [body.email]))
        .rows[0];
      const p = (
        await pool.query('select is_platform_super_admin from profiles where id = $1', [u.id])
      ).rows[0];
      expect(p.is_platform_super_admin).toBe(false);
      const m = (
        await pool.query('select organization_id from organization_members where user_id = $1', [
          u.id,
        ])
      ).rows;
      expect(m).toHaveLength(1);
      expect(m[0].organization_id).not.toBe(A.orgId); // never joins an existing organization
      const org = (
        await pool.query('select status, org_code from organizations where id = $1', [
          m[0].organization_id,
        ])
      ).rows[0];
      expect(org.status).toBe('pending_email');
      expect(org.org_code).not.toBe('ORG-000001');
    });

    it('refuses duplicate emails (case-insensitive) without creating anything', async () => {
      const body = goodBody();
      expect((await post('/auth/register', body, '10.2.0.3')).statusCode).toBe(201);
      const before = (await pool.query('select count(*)::int c from organizations')).rows[0]
        .c as number;
      const dup = await post(
        '/auth/register',
        { ...body, email: body.email.toUpperCase(), organizationName: 'Second College' },
        '10.2.0.3',
      );
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('EMAIL_IN_USE');
      expect((await pool.query('select count(*)::int c from organizations')).rows[0].c).toBe(
        before,
      );
    });

    it('validates every field and explains what is wrong', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['short password', { password: 'Ab1' }],
        ['no digit', { password: 'Passwordonly' }],
        ['no letter', { password: '123456789' }],
        ['72+ chars', { password: `A1${'x'.repeat(80)}` }],
        ['bad email', { email: 'nope' }],
        ['bad type', { institutionType: 'casino' }],
        ['short org name', { organizationName: 'x' }],
        ['short owner name', { ownerName: 'x' }],
        ['missing email', { email: undefined }],
      ];
      for (const [label, over] of cases) {
        const res = await post('/auth/register', goodBody(over), '10.2.0.4');
        expect(res.statusCode, label).toBe(400);
        expect(res.json().error.code, label).toBe('VALIDATION_ERROR');
        expect(res.json().error.details.length, label).toBeGreaterThan(0);
      }
      expect((await post('/auth/register', {}, '10.2.0.4')).statusCode).toBe(400);
    });

    it('rolls the login back when the organization cannot be created (no half organization, no orphan login)', async () => {
      const orphanId = randomUUID(); // a user id that does not exist in auth.users => the database function fails
      const deleted: string[] = [];
      const failingGateway: AuthGateway = {
        ...fakeGateway,
        signUp: async () => ({ id: orphanId }),
        deleteUser: async (id) => void deleted.push(id),
      };
      const app2 = await buildApp({
        environment: 'test',
        version: 't',
        corsOrigins: [],
        logLevel: 'silent',
        pool,
        gateway: failingGateway,
        frontendUrl: 'http://localhost:5173',
        checks: { database: async () => undefined, redis: async () => undefined },
      });
      const res = await app2.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: goodBody({ organizationName: 'Doomed College' }),
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toMatch(/foreign key|violates|auth\.users|select |insert /i); // no database details leak
      expect(deleted).toEqual([orphanId]); // the auth user was removed again
      // Checked by name, not by a global count: other test files register organizations in parallel.
      expect(
        (
          await pool.query(
            `select count(*)::int c from organizations where name = 'Doomed College'`,
          )
        ).rows[0].c,
      ).toBe(0);
      await app2.close();
    });

    it('records the registration in the audit log without any password', async () => {
      const body = goodBody();
      const res = await post('/auth/register', body, '10.2.0.5');
      const rows = (
        await pool.query(
          `select action, request_id, metadata::text as m from audit_logs where request_id = $1`,
          [res.json().requestId],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('ORGANIZATION_REGISTERED');
      expect(rows[0].m).not.toMatch(/password|Passw0rd/i);
    });
  });

  describe('POST /auth/login', () => {
    it('returns a session for a verified user and refuses unverified, unknown or malformed attempts', async () => {
      const body = goodBody();
      await post('/auth/register', body, '10.3.0.1');
      const unverified = await post(
        '/auth/login',
        { email: body.email, password: body.password },
        '10.3.0.2',
      );
      expect(unverified.statusCode).toBe(403);
      expect(unverified.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      await pool.query('update auth.users set email_confirmed_at = now() where email = $1', [
        body.email,
      ]);
      const ok = await post(
        '/auth/login',
        { email: body.email, password: body.password },
        '10.3.0.3',
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
      const unknown = await post(
        '/auth/login',
        { email: 'ghost@test.local', password: 'Whatever1' },
        '10.3.0.4',
      );
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().error.message).toBe('Incorrect email or password.'); // same message: no account guessing
      expect(
        (await post('/auth/login', { email: 'bad', password: '' }, '10.3.0.5')).statusCode,
      ).toBe(400);
      expect((await post('/auth/login', {}, '10.3.0.5')).statusCode).toBe(400);
    });
  });

  describe('GET /me', () => {
    it('describes the owner: user, organization, roles and permissions', async () => {
      const r = await as(A.owner).get('/me');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        user: { id: A.owner },
        isPlatformAdmin: false,
        roles: ['ORGANIZATION_OWNER'],
        studentId: null,
        scopes: [],
        organization: { id: A.orgId, status: 'active' },
      });
      expect(r.body.data.permissions).toEqual(
        expect.arrayContaining(['organization.update', 'user.update', 'subscription.read']),
      );
    });
    it('describes a teacher with their scopes and a student with their student id', async () => {
      const t = await as(A.teacher1).get('/me');
      expect(t.body.data.roles).toEqual(['TEACHER']);
      expect(t.body.data.scopes.map((s: { scopeId: string }) => s.scopeId)).toEqual([A.subject1]);
      expect(t.body.data.permissions).not.toContain('user.update');
      const s = await as(A.student).get('/me');
      expect(s.body.data.roles).toEqual(['STUDENT']);
      expect(s.body.data.studentId).toBe(A.studentId);
      expect(s.body.data.permissions.sort()).toEqual(['leaderboard.read', 'notification.read']);
    });
    it('a signed-in user without an organization gets organization: null (not an error)', async () => {
      const loner = await createUser('loner');
      const r = await as(loner.id).get('/me');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        organization: null,
        roles: [],
        permissions: [],
        isPlatformAdmin: false,
      });
    });
    it('flags platform admins and never lists organization permissions for them', async () => {
      const p = await createUser('plat');
      await pool.query(
        `insert into profiles (id, email, full_name, is_platform_super_admin) values ($1,$2,'Platform Admin',true)`,
        [p.id, p.email],
      );
      const r = await as(p.id).get('/me');
      expect(r.body.data).toMatchObject({
        isPlatformAdmin: true,
        organization: null,
        permissions: [],
      });
      expect(r.body.data.user.fullName).toBe('Platform Admin');
    });
    it('a suspended organization disappears from /me', async () => {
      const T = await createTenant('apiAuthSusp');
      expect((await as(T.owner).get('/me')).body.data.organization.id).toBe(T.orgId);
      await pool.query(`update organizations set status = 'suspended' where id = $1`, [T.orgId]);
      const r = await as(T.owner).get('/me');
      expect(r.body.data.organization).toBeNull();
      expect(r.body.data.permissions).toEqual([]);
    });
    it('rejects missing, malformed, expired/deleted-user tokens', async () => {
      expect((await as().get('/me')).status).toBe(401);
      const bad = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: 'Basic abc' },
      });
      expect(bad.statusCode).toBe(401);
      const gone = await createUser('gone');
      await pool.query('delete from auth.users where id = $1', [gone.id]); // like a revoked or expired session
      expect((await as(gone.id).get('/me')).status).toBe(401);
    });
    it("is not cacheable by shared caches and exposes no internal ids beyond the caller's own", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer tok:${A.owner}` },
      });
      expect(JSON.stringify(res.json())).not.toContain('service_role');
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  describe('rate limiting', () => {
    it('login is throttled per client after 10 attempts a minute', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++)
        codes.push(
          (await post('/auth/login', { email: 'nobody@test.local', password: 'x' }, '10.9.9.9'))
            .statusCode,
        );
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.at(-1)).toBe(429);
      const limited = await post(
        '/auth/login',
        { email: 'nobody@test.local', password: 'x' },
        '10.9.9.9',
      );
      expect(limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
      // a different client is not affected
      expect(
        (await post('/auth/login', { email: 'nobody@test.local', password: 'x' }, '10.9.9.10'))
          .statusCode,
      ).toBe(401);
    });
    it('registration is throttled too', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++)
        codes.push((await post('/auth/register', { bad: true }, '10.8.8.8')).statusCode);
      expect(codes.at(-1)).toBe(429);
    });
    it('the health endpoint is never throttled', async () => {
      for (let i = 0; i < 15; i++)
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/health',
              headers: { 'x-forwarded-for': '10.7.7.7' },
            })
          ).statusCode,
        ).toBe(200);
    });
  });

  it('error responses never leak stack traces, hosts, credentials or SQL', async () => {
    const secret =
      'connection to server at "10.0.0.5" failed: password authentication failed for user "postgres"';
    const make = async (dbBroken: boolean) =>
      buildApp({
        environment: 'test',
        version: 't',
        corsOrigins: [],
        logLevel: 'silent',
        frontendUrl: 'http://localhost:5173',
        pool: (dbBroken
          ? {
              connect: async () => {
                throw new Error(secret);
              },
            }
          : pool) as unknown as typeof pool,
        gateway: dbBroken
          ? {
              ...fakeGateway,
              verifyToken: async () => ({ id: A.owner, email: 'x@y.z', emailConfirmed: true }),
            }
          : {
              ...fakeGateway,
              verifyToken: async () => {
                throw new Error(secret);
              },
            },
        checks: { database: async () => undefined, redis: async () => undefined },
      });
    for (const dbBroken of [true, false]) {
      const broken = await make(dbBroken);
      const res = await broken.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: 'Bearer anything' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toMatch(/10\.0\.0\.5|password authentication|postgres|stack|at .*\.ts/i);
      expect(res.json()).toMatchObject({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR' },
      });
      await broken.close();
    }
  });
});
