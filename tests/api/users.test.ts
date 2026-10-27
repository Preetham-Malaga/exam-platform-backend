import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

describe.skipIf(!DATABASE_TEST_URL)(
  'Users, roles and permissions API (real app + real PostgreSQL)',
  () => {
    let app: FastifyInstance;
    let A: Tenant;
    let B: Tenant;
    const as = (id?: string) => new Client(app, id);
    const newEmail = (p = 'invitee') => `${p}.${randomUUID()}@test.local`;

    beforeAll(async () => {
      app = await makeApp();
      A = await createTenant('apiUsersA');
      B = await createTenant('apiUsersB');
    });
    afterAll(async () => {
      await app.close();
      await pool.end();
    });

    describe('permission matrix: every role against every users/roles/organization endpoint', () => {
      // [method, path, body, expected status per role: owner, admin, teacher, student]
      const matrix: Array<
        [string, string, (t: Tenant) => unknown, [number, number, number, number]]
      > = [
        ['GET', '/organizations/current', () => undefined, [200, 200, 200, 403]],
        [
          'PATCH',
          '/organizations/current',
          () => ({ name: 'Matrix College' }),
          [200, 403, 403, 403],
        ],
        [
          'PATCH',
          '/organizations/current/settings',
          () => ({ branding: { primaryColor: '#101010' } }),
          [200, 200, 403, 403],
        ],
        ['GET', '/users', () => undefined, [200, 200, 403, 403]],
        ['GET', '/roles', () => undefined, [200, 200, 403, 403]],
        [
          'POST',
          '/users/admins',
          () => ({ email: `${randomUUID()}@m.test`, fullName: 'Matrix Admin' }),
          [201, 403, 403, 403],
        ],
        ['PUT', '/users/:teacher2/role', () => ({ role: 'TEACHER' }), [200, 200, 403, 403]],
        ['PATCH', '/users/:teacher2/status', () => ({ status: 'active' }), [200, 200, 403, 403]],
      ];
      for (const [method, path, body, expected] of matrix) {
        it(`${method} ${path}`, async () => {
          const T = await createTenant('matrixapi');
          const users = [T.owner, T.admin, T.teacher1, T.student];
          const results: number[] = [];
          for (const u of users) {
            const url = path.replace(':teacher2', T.teacher2);
            const r = await as(u).call(method as 'GET', url, body(T));
            results.push(r.status);
          }
          expect(results, `owner, admin, teacher, student`).toEqual(expected);
        });
      }
      it('unauthenticated callers get 401 on all of them', async () => {
        for (const [method, path, body] of matrix) {
          const r = await as().call(
            method as 'GET',
            path.replace(':teacher2', A.teacher2),
            body(A),
          );
          expect(r.status, `${method} ${path}`).toBe(401);
        }
      });
    });

    describe('GET /users', () => {
      it('lists members with roles, status and pagination; never other organizations', async () => {
        const r = await as(A.owner).get('/users?pageSize=100');
        expect(r.status).toBe(200);
        const items = r.body.data.items as Array<{
          userId: string;
          email: string;
          fullName: string;
          status: string;
          roles: string[];
        }>;
        expect(items).toHaveLength(6);
        expect(items.find((u) => u.userId === A.owner)!.roles).toEqual(['ORGANIZATION_OWNER']);
        expect(items.find((u) => u.userId === A.teacher1)!.roles).toEqual(['TEACHER']);
        expect(items.every((u) => u.status === 'active' && u.email.includes('@'))).toBe(true);
        expect(items.map((u) => u.userId)).not.toContain(B.owner);
        expect(r.body.data.pagination).toMatchObject({
          page: 1,
          pageSize: 100,
          total: 6,
          totalPages: 1,
        });
      });
      it('paginates, searches, filters by role and sorts', async () => {
        const p1 = await as(A.owner).get('/users?pageSize=2&page=1&sort=email&order=asc');
        expect(p1.body.data.items).toHaveLength(2);
        expect(p1.body.data.pagination).toMatchObject({ total: 6, totalPages: 3 });
        const emails = (
          await as(A.owner).get('/users?pageSize=100&sort=email&order=asc')
        ).body.data.items.map((u: { email: string }) => u.email);
        expect(emails).toEqual([...emails].sort());
        const teachers = await as(A.admin).get('/users?role=TEACHER');
        expect(teachers.body.data.items.map((u: { userId: string }) => u.userId).sort()).toEqual(
          [A.teacher1, A.teacher2].sort(),
        );
        const found = await as(A.owner).get('/users?search=teacher1');
        expect(found.body.data.items.map((u: { userId: string }) => u.userId)).toEqual([
          A.teacher1,
        ]);
        expect((await as(A.owner).get('/users?search=%25')).body.data.pagination.total).toBe(0); // wildcard matched literally
        expect((await as(A.owner).get('/users?role=GOD')).status).toBe(400);
        expect((await as(A.owner).get('/users?pageSize=1000')).status).toBe(400);
        expect((await as(A.owner).get('/users?sort=password;drop%20table%20profiles')).status).toBe(
          200,
        ); // unknown sort falls back safely
      });
    });

    describe('GET /roles', () => {
      it('describes the four organization roles and their permissions (platform role is not listed)', async () => {
        const r = await as(A.owner).get('/roles');
        const roles = r.body.data.roles as Array<{ code: string; permissions: string[] }>;
        expect(roles.map((x) => x.code)).toEqual([
          'ORGANIZATION_OWNER',
          'ORGANIZATION_ADMIN',
          'TEACHER',
          'STUDENT',
        ]);
        const by = Object.fromEntries(roles.map((x) => [x.code, x.permissions]));
        expect(by.STUDENT).toEqual(['leaderboard.read', 'notification.read']);
        expect(by.TEACHER).toContain('question.create');
        expect(by.TEACHER).not.toContain('user.update');
        expect(by.ORGANIZATION_ADMIN).not.toContain('organization.update');
        expect(by.ORGANIZATION_OWNER).toContain('organization.update');
        expect(by.ORGANIZATION_OWNER!.length).toBeGreaterThan(by.ORGANIZATION_ADMIN!.length);
      });
    });

    describe('POST /users/admins (owner only)', () => {
      it('invites an admin: login, membership and role are created together and the audit log records it', async () => {
        const email = newEmail('admin');
        const r = await as(A.owner).post('/users/admins', { email, fullName: 'New Admin' });
        expect(r.status).toBe(201);
        const uid = r.body.data.userId as string;
        const roles = (
          await pool.query(
            `select r.code from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and ur.organization_id = $2`,
            [uid, A.orgId],
          )
        ).rows.map((x) => x.code);
        expect(roles).toEqual(['ORGANIZATION_ADMIN']);
        const me = await as(uid).get('/me');
        expect(me.body.data.roles).toEqual(['ORGANIZATION_ADMIN']);
        expect(me.body.data.permissions).toContain('user.update');
        expect(me.body.data.permissions).not.toContain('organization.update');
        const log = await pool.query(
          `select action from audit_logs where organization_id = $1 and resource_id = $2`,
          [A.orgId, uid],
        );
        expect(log.rows.map((x) => x.action)).toContain('USER_CREATED');
      });
      it('is idempotent: inviting the same email again does not duplicate anything', async () => {
        const email = newEmail('twice');
        const a = await as(A.owner).post('/users/admins', { email, fullName: 'Twice' });
        const b = await as(A.owner).post('/users/admins', { email, fullName: 'Twice' });
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(b.body.data.userId).toBe(a.body.data.userId);
        expect(
          (
            await pool.query(
              'select count(*)::int c from organization_members where user_id = $1',
              [a.body.data.userId],
            )
          ).rows[0].c,
        ).toBe(1);
        expect(
          (
            await pool.query('select count(*)::int c from user_roles where user_id = $1', [
              a.body.data.userId,
            ])
          ).rows[0].c,
        ).toBe(1);
      });
      it('links an existing account (already used in another organization) without touching the other organization', async () => {
        const email = (await pool.query('select email from auth.users where id = $1', [B.teacher1]))
          .rows[0].email as string;
        const r = await as(A.owner).post('/users/admins', { email, fullName: 'Shared Person' });
        expect(r.status).toBe(201);
        expect(r.body.data.userId).toBe(B.teacher1);
        const m = (
          await pool.query(
            'select organization_id from organization_members where user_id = $1 order by created_at',
            [B.teacher1],
          )
        ).rows.map((x) => x.organization_id);
        expect(m).toEqual(expect.arrayContaining([A.orgId, B.orgId]));
        const roleInB = (
          await pool.query(
            `select r.code from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and ur.organization_id = $2`,
            [B.teacher1, B.orgId],
          )
        ).rows.map((x) => x.code);
        expect(roleInB).toEqual(['TEACHER']); // unchanged
        expect(
          (await as(B.owner).get('/users?pageSize=100')).body.data.items.find(
            (u: { userId: string }) => u.userId === B.teacher1,
          ).roles,
        ).toEqual(['TEACHER']);
      });
      it('validates the body', async () => {
        const c = as(A.owner);
        expect(
          (await c.post('/users/admins', { email: 'nope', fullName: 'Valid Name' })).status,
        ).toBe(400);
        expect((await c.post('/users/admins', { email: newEmail(), fullName: 'x' })).status).toBe(
          400,
        );
        expect((await c.post('/users/admins', {})).status).toBe(400);
      });
    });

    describe('PUT /users/:id/role', () => {
      it('owner can move people between Student, Teacher and Admin; permissions follow immediately', async () => {
        const T = await createTenant('rolechg');
        const o = as(T.owner);
        expect((await as(T.student).get('/me')).body.data.permissions).not.toContain(
          'question.create',
        );
        expect((await o.put(`/users/${T.student}/role`, { role: 'TEACHER' })).status).toBe(200);
        const asTeacher = (await as(T.student).get('/me')).body.data;
        expect(asTeacher.roles).toEqual(['TEACHER']); // replaced, not added
        expect(asTeacher.permissions).toContain('question.create');
        expect(
          (await o.put(`/users/${T.student}/role`, { role: 'ORGANIZATION_ADMIN' })).status,
        ).toBe(200);
        expect((await as(T.student).get('/me')).body.data.permissions).toContain('user.update');
        expect((await o.put(`/users/${T.student}/role`, { role: 'STUDENT' })).status).toBe(200);
        const back = (await as(T.student).get('/me')).body.data;
        expect(back.roles).toEqual(['STUDENT']);
        expect(back.permissions).not.toContain('user.update');
        const log = await pool.query(
          `select count(*)::int c from audit_logs where organization_id = $1 and action = 'ROLE_CHANGED'`,
          [T.orgId],
        );
        expect(log.rows[0].c).toBe(3);
      });
      it('admin can change Teacher/Student only; admins and the owner are off limits', async () => {
        const T = await createTenant('adminrole');
        const a = as(T.admin);
        expect((await a.put(`/users/${T.teacher2}/role`, { role: 'STUDENT' })).status).toBe(200);
        expect(
          (await a.put(`/users/${T.teacher2}/role`, { role: 'ORGANIZATION_ADMIN' })).status,
        ).toBe(403); // cannot create admins
        expect((await a.put(`/users/${T.owner}/role`, { role: 'TEACHER' })).status).toBe(403);
        expect((await a.put(`/users/${T.admin}/role`, { role: 'TEACHER' })).status).toBe(400); // not your own
        const newAdmin = await as(T.owner).post('/users/admins', {
          email: newEmail(),
          fullName: 'Second Admin',
        });
        expect(
          (await a.put(`/users/${newAdmin.body.data.userId}/role`, { role: 'TEACHER' })).status,
        ).toBe(403); // cannot demote another admin
        // nothing changed for the protected users
        expect((await as(T.owner).get('/me')).body.data.roles).toEqual(['ORGANIZATION_OWNER']);
        expect((await as(newAdmin.body.data.userId).get('/me')).body.data.roles).toEqual([
          'ORGANIZATION_ADMIN',
        ]);
      });
      it('the owner role can neither be given nor removed; unknown roles and users are rejected', async () => {
        const T = await createTenant('ownerrole');
        const o = as(T.owner);
        expect(
          (await o.put(`/users/${T.teacher1}/role`, { role: 'ORGANIZATION_OWNER' })).status,
        ).toBe(400);
        expect(
          (await o.put(`/users/${T.teacher1}/role`, { role: 'PLATFORM_SUPER_ADMIN' })).status,
        ).toBe(400);
        expect((await o.put(`/users/${T.teacher1}/role`, { role: 'GOD' })).status).toBe(400);
        expect((await o.put(`/users/${T.owner}/role`, { role: 'TEACHER' })).status).toBe(400); // owner cannot demote themselves
        expect((await o.put(`/users/${randomUUID()}/role`, { role: 'TEACHER' })).status).toBe(404);
        expect((await o.put('/users/not-a-uuid/role', { role: 'TEACHER' })).status).toBe(400);
        expect((await as(T.owner).get('/me')).body.data.roles).toEqual(['ORGANIZATION_OWNER']);
      });
      it("cannot reach another organization's users", async () => {
        expect(
          (await as(A.owner).put(`/users/${B.teacher2}/role`, { role: 'STUDENT' })).status,
        ).toBe(404);
        expect((await as(B.owner).get('/me')).body.data.roles).toEqual(['ORGANIZATION_OWNER']);
        expect((await as(B.teacher2).get('/me')).body.data.roles).toEqual(['TEACHER']);
      });
      it('teachers and students cannot change roles, including their own', async () => {
        const T = await createTenant('norole');
        expect(
          (await as(T.teacher1).put(`/users/${T.teacher1}/role`, { role: 'ORGANIZATION_ADMIN' }))
            .status,
        ).toBe(403);
        expect(
          (await as(T.student).put(`/users/${T.student}/role`, { role: 'ORGANIZATION_ADMIN' }))
            .status,
        ).toBe(403);
        expect((await as(T.student).get('/me')).body.data.roles).toEqual(['STUDENT']);
      });
    });

    describe('PATCH /users/:id/status', () => {
      it('suspending locks the person out of the organization at once; reactivating restores access', async () => {
        const T = await createTenant('suspend2');
        expect((await as(T.teacher1).get('/organizations/current')).status).toBe(200);
        expect(
          (await as(T.admin).patch(`/users/${T.teacher1}/status`, { status: 'suspended' })).status,
        ).toBe(200);
        const me = await as(T.teacher1).get('/me');
        expect(me.body.data.organization).toBeNull();
        expect(me.body.data.permissions).toEqual([]);
        expect((await as(T.teacher1).get('/organizations/current')).status).toBe(403);
        expect(
          (await as(T.owner).get('/users?pageSize=100')).body.data.items.find(
            (u: { userId: string }) => u.userId === T.teacher1,
          ).status,
        ).toBe('suspended');
        expect(
          (await as(T.admin).patch(`/users/${T.teacher1}/status`, { status: 'active' })).status,
        ).toBe(200);
        expect((await as(T.teacher1).get('/organizations/current')).status).toBe(200);
      });
      it('cannot suspend yourself or the owner; rejects bad input and other organizations', async () => {
        const T = await createTenant('suspend3');
        expect(
          (await as(T.admin).patch(`/users/${T.admin}/status`, { status: 'suspended' })).status,
        ).toBe(400);
        expect(
          (await as(T.admin).patch(`/users/${T.owner}/status`, { status: 'suspended' })).status,
        ).toBe(404);
        expect((await as(T.owner).get('/me')).body.data.organization).not.toBeNull();
        expect(
          (await as(T.owner).patch(`/users/${T.teacher1}/status`, { status: 'deleted' })).status,
        ).toBe(400);
        expect(
          (await as(A.owner).patch(`/users/${B.student}/status`, { status: 'suspended' })).status,
        ).toBe(404);
        expect((await as(B.student).get('/me')).body.data.organization).not.toBeNull();
      });
    });
  },
);
