import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, createUser, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

describe.skipIf(!DATABASE_TEST_URL)('Organization API (real app + real PostgreSQL)', () => {
  let app: FastifyInstance;
  let A: Tenant;
  let B: Tenant;
  const as = (id?: string) => new Client(app, id);

  beforeAll(async () => {
    app = await makeApp();
    A = await createTenant('apiOrgA');
    B = await createTenant('apiOrgB');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('authentication and the response envelope', () => {
    it('rejects a missing, malformed or forged token with the standard error envelope', async () => {
      const none = await as().get('/organizations/current');
      expect(none.status).toBe(401);
      expect(none.body).toMatchObject({
        success: false,
        data: null,
        error: { code: 'UNAUTHENTICATED' },
      });
      expect(typeof none.body.requestId).toBe('string');
      const bad = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations/current',
        headers: { authorization: 'Bearer not-a-token' },
      });
      expect(bad.statusCode).toBe(401);
      const forged = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations/current',
        headers: { authorization: 'Bearer tok:00000000-0000-4000-8000-000000000000' },
      });
      expect(forged.statusCode).toBe(401);
    });
    it('a signed-in user with no organization is told so (not a crash)', async () => {
      const loner = await createUser('loner');
      const r = await as(loner.id).get('/organizations/current');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NO_ORGANIZATION');
    });
  });

  describe('GET /organizations/current', () => {
    it("returns the caller's own organization (derived from membership, never from the request)", async () => {
      const r = await as(A.owner).get('/organizations/current');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        id: A.orgId,
        institutionType: 'engineering',
        timezone: 'Asia/Kolkata',
        branding: {},
      });
      expect(r.body.data.orgCode).toMatch(/^ORG-\d{6}$/);
      expect(r.body.data.name).toBe('apiOrgA College');
    });
    it('ignores any organization id the client tries to send', async () => {
      const viaQuery = await as(A.owner).get(
        `/organizations/current?organizationId=${B.orgId}&organization_id=${B.orgId}`,
      );
      expect(viaQuery.body.data.id).toBe(A.orgId);
      const viaHeader = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations/current',
        headers: { authorization: `Bearer tok:${A.owner}`, 'x-organization-id': B.orgId },
      });
      expect(viaHeader.json().data.id).toBe(A.orgId);
    });
    it('College B sees only College B', async () => {
      const r = await as(B.owner).get('/organizations/current');
      expect(r.body.data.id).toBe(B.orgId);
      expect(r.body.data.name).toBe('apiOrgB College');
    });
    it('owner, admin and teacher may read it; a student may not', async () => {
      for (const u of [A.owner, A.admin, A.teacher1])
        expect((await as(u).get('/organizations/current')).status).toBe(200);
      const s = await as(A.student).get('/organizations/current');
      expect(s.status).toBe(403);
      expect(s.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('PATCH /organizations/current', () => {
    it('the owner can update the profile; blank optional fields can be cleared', async () => {
      const r = await as(A.owner).patch('/organizations/current', {
        name: 'Renamed College',
        contactEmail: 'office@college.test',
        contactPhone: '+91 99999 00000',
        address: 'Main Road',
      });
      expect(r.status).toBe(200);
      let now = (await as(A.owner).get('/organizations/current')).body.data;
      expect(now).toMatchObject({
        name: 'Renamed College',
        contactEmail: 'office@college.test',
        contactPhone: '+91 99999 00000',
        address: 'Main Road',
      });
      await as(A.owner).patch('/organizations/current', { contactPhone: null, address: null });
      now = (await as(A.owner).get('/organizations/current')).body.data;
      expect(now.contactPhone).toBeNull();
      expect(now.address).toBeNull();
    });
    it('admin, teacher and student cannot update it, and nothing changes', async () => {
      for (const u of [A.admin, A.teacher1, A.student]) {
        const r = await as(u).patch('/organizations/current', { name: 'Hacked' });
        expect(r.status, 'patch').toBe(403);
      }
      expect((await as(A.owner).get('/organizations/current')).body.data.name).toBe(
        'Renamed College',
      );
    });
    it('validates input and refuses fields the client must never set', async () => {
      const c = as(A.owner);
      expect((await c.patch('/organizations/current', { name: 'x' })).status).toBe(400);
      expect(
        (await c.patch('/organizations/current', { contactEmail: 'not-an-email' })).status,
      ).toBe(400);
      for (const evil of [
        { status: 'active' },
        { orgCode: 'ORG-000001' },
        { id: B.orgId },
        { organizationId: B.orgId },
        { institutionType: 'school' },
        { deletedAt: '2020-01-01T00:00:00Z' },
      ]) {
        const r = await c.patch('/organizations/current', evil);
        expect(r.status, JSON.stringify(evil)).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
    it('an empty update is a harmless no-op', async () => {
      const r = await as(A.owner).patch('/organizations/current', {});
      expect(r.status).toBe(200);
      expect(r.body.data.updated).toBe(false);
    });
    it("one college's update never touches another", async () => {
      await as(B.owner).patch('/organizations/current', { name: 'B Renamed' });
      expect((await as(A.owner).get('/organizations/current')).body.data.name).toBe(
        'Renamed College',
      );
      expect((await as(B.owner).get('/organizations/current')).body.data.name).toBe('B Renamed');
    });
  });

  describe('PATCH /organizations/current/settings (branding)', () => {
    it('owner and admin can save branding; teacher and student cannot', async () => {
      const body = {
        branding: { primaryColor: '#123456', tagline: 'Learn well' },
        timezone: 'Asia/Kolkata',
      };
      const r = await as(A.owner).patch('/organizations/current/settings', body);
      expect(r.status).toBe(200);
      expect(r.body.data.branding).toEqual({ primaryColor: '#123456', tagline: 'Learn well' });
      expect(
        (
          await as(A.admin).patch('/organizations/current/settings', {
            branding: { primaryColor: '#abcdef' },
          })
        ).status,
      ).toBe(200);
      expect((await as(A.teacher1).patch('/organizations/current/settings', body)).status).toBe(
        403,
      );
      expect((await as(A.student).patch('/organizations/current/settings', body)).status).toBe(403);
      expect(
        (await as(A.owner).get('/organizations/current')).body.data.branding.primaryColor,
      ).toBe('#abcdef');
    });
    it('rejects bad colours and unknown branding keys', async () => {
      const c = as(A.owner);
      expect(
        (await c.patch('/organizations/current/settings', { branding: { primaryColor: 'red' } }))
          .status,
      ).toBe(400);
      expect(
        (await c.patch('/organizations/current/settings', { branding: { evil: '<script>' } }))
          .status,
      ).toBe(400);
      expect(
        (await c.patch('/organizations/current/settings', { onboardingCompletedAt: 'x' })).status,
      ).toBe(400);
    });
    it('branding is per organization', async () => {
      expect((await as(B.owner).get('/organizations/current')).body.data.branding).toEqual({});
    });
  });

  describe('lifecycle', () => {
    it('a new organization becomes active when the owner verifies their email', async () => {
      const u = await createUser('lifecycle');
      await pool.query('select app.register_organization($1,$2,$3,$4,$5)', [
        u.id,
        u.email,
        'Owner',
        'Lifecycle College',
        'school',
      ]);
      await pool.query('update auth.users set email_confirmed_at = null where id = $1', [u.id]); // not verified yet
      let r = await as(u.id).get('/organizations/current');
      expect(r.body.data.status).toBe('pending_email');
      await pool.query('update auth.users set email_confirmed_at = now() where id = $1', [u.id]);
      r = await as(u.id).get('/organizations/current');
      expect(r.body.data.status).toBe('active');
    });
    it('suspending an organization locks its users out immediately', async () => {
      const T = await createTenant('apiSuspend');
      expect((await as(T.owner).get('/organizations/current')).status).toBe(200);
      await pool.query(`update organizations set status = 'suspended' where id = $1`, [T.orgId]);
      const r = await as(T.owner).get('/organizations/current');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NO_ORGANIZATION');
    });
  });

  describe('audit trail', () => {
    it('records who changed the organization, with the request id', async () => {
      const upd = await as(A.owner).patch('/organizations/current', { name: 'Audited College' });
      const log = await pool.query(
        `select user_id, action, resource, request_id from audit_logs where organization_id = $1 and action = 'ORGANIZATION_UPDATED' order by created_at desc limit 1`,
        [A.orgId],
      );
      expect(log.rows[0]).toMatchObject({
        user_id: A.owner,
        resource: 'organizations',
        request_id: upd.body.requestId,
      });
    });
    it('failed (forbidden) updates are not logged as changes', async () => {
      const before = (
        await pool.query(
          `select count(*)::int c from audit_logs where organization_id = $1 and action = 'ORGANIZATION_UPDATED'`,
          [A.orgId],
        )
      ).rows[0].c as number;
      await as(A.teacher1).patch('/organizations/current', { name: 'x2' });
      const after = (
        await pool.query(
          `select count(*)::int c from audit_logs where organization_id = $1 and action = 'ORGANIZATION_UPDATED'`,
          [A.orgId],
        )
      ).rows[0].c as number;
      expect(after).toBe(before);
    });
  });
});
