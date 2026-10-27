// Phase 9: teacher management (records, invitations, activation/removal, scope) on the real app + real PostgreSQL.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

const code = (p = 'T') => `${p}${randomUUID().slice(0, 8)}`;
const email = (p = 'teacher') => `${p}.${randomUUID()}@test.local`;

describe.skipIf(!DATABASE_TEST_URL)('Teachers API (real app + real PostgreSQL)', () => {
  let app: FastifyInstance;
  let A: Tenant;
  let B: Tenant;
  const as = (id?: string) => new Client(app, id);
  const emailOf = async (userId: string) =>
    (await pool.query('select email from auth.users where id = $1', [userId])).rows[0]
      .email as string;
  const rolesOf = async (T: Tenant, userId: string) =>
    (
      await pool.query(
        `select r.code from user_roles ur join roles r on r.id = ur.role_id
         where ur.organization_id = $1 and ur.user_id = $2 order by 1`,
        [T.orgId, userId],
      )
    ).rows.map((r) => r.code as string);
  /** Invites a brand-new teacher in T and returns the teacher record. */
  const invite = async (T: Tenant, over: Record<string, unknown> = {}) => {
    const r = await as(T.owner).post('/teachers', {
      employeeCode: code(),
      fullName: 'New Teacher',
      email: email(),
      ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data;
  };

  beforeAll(async () => {
    app = await makeApp();
    A = await createTenant('teachA');
    B = await createTenant('teachB');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('permission matrix: owner, admin, teacher, student', () => {
    let T: Tenant;
    let teacherId: string;
    beforeAll(async () => {
      T = await createTenant('teachMatrix');
      teacherId = (await invite(T)).id;
    });
    const matrix: Array<[string, string, () => unknown, [number, number, number, number]]> = [
      ['GET', '/teachers', () => undefined, [200, 200, 403, 403]],
      ['GET', '/teachers/:id', () => undefined, [200, 200, 403, 403]],
      [
        'POST',
        '/teachers',
        () => ({ employeeCode: code(), fullName: 'No Login', invite: false }),
        [201, 201, 403, 403],
      ],
      ['PATCH', '/teachers/:id', () => ({ phone: '99999' }), [200, 200, 403, 403]],
      ['PUT', '/teachers/:id/scopes', () => ({ scopes: [] }), [200, 200, 403, 403]],
    ];
    for (const [method, path, body, expected] of matrix)
      it(`${method} ${path}`, async () => {
        const results: number[] = [];
        for (const u of [T.owner, T.admin, T.teacher1, T.student])
          results.push(
            (await as(u).call(method as 'GET', path.replace(':id', teacherId), body())).status,
          );
        expect(results, 'owner, admin, teacher, student').toEqual(expected);
      });
    it('unauthenticated callers get 401', async () => {
      for (const [method, path, body] of matrix)
        expect(
          (await as().call(method as 'GET', path.replace(':id', teacherId), body())).status,
        ).toBe(401);
    });
  });

  describe('adding teachers', () => {
    it('invites a new person: login + TEACHER membership + teacher record, in one go', async () => {
      const e = email('new');
      const t = await invite(A, { email: e, fullName: 'Ravi Kumar', phone: '12345' });
      expect(t).toMatchObject({
        fullName: 'Ravi Kumar',
        email: e,
        accountStatus: 'active',
        scopeCount: 0,
      });
      expect(t.userId).toBeTruthy();
      expect(await emailOf(t.userId)).toBe(e);
      expect(await rolesOf(A, t.userId)).toEqual(['TEACHER']);
      const me = await as(t.userId).get('/me');
      expect(me.body.data.roles).toEqual(['TEACHER']);
    });

    it('links a member who already has the Teacher role (e.g. made a teacher on the Users page)', async () => {
      const r = await as(A.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Teacher Two',
        email: await emailOf(A.teacher2),
      });
      expect(r.status).toBe(201);
      expect(r.body.data.userId).toBe(A.teacher2);
      expect(await rolesOf(A, A.teacher2)).toEqual(['TEACHER']);
      // ...but only once
      const again = await as(A.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Teacher Two again',
        email: await emailOf(A.teacher2),
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('TEACHER_EXISTS');
    });

    it('refuses someone who already belongs to the organization with another role (no second role)', async () => {
      const r = await as(A.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Student',
        email: await emailOf(A.student),
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'ALREADY_MEMBER',
        details: { roles: ['STUDENT'] },
      });
      expect(await rolesOf(A, A.student)).toEqual(['STUDENT']);
    });

    it('a failed creation leaves no login, membership or record behind', async () => {
      const taken = code('DUP');
      await invite(A, { employeeCode: taken });
      const e = email('rollback');
      const r = await as(A.owner).post('/teachers', {
        employeeCode: taken,
        fullName: 'Dup',
        email: e,
      });
      expect(r.status).toBe(409);
      expect((await pool.query('select 1 from auth.users where email = $1', [e])).rowCount).toBe(0);
      expect(
        (
          await pool.query('select 1 from teachers where organization_id = $1 and email = $2', [
            A.orgId,
            e,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it('can add a record first and send the invitation later', async () => {
      expect(
        (await as(A.owner).post('/teachers', { employeeCode: code(), fullName: 'No Mail' })).body
          .error.code,
      ).toBe('EMAIL_REQUIRED');
      const e = email('later');
      const r = await as(A.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Later',
        email: e,
        invite: false,
      });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ userId: null, accountStatus: null });
      const inv = await as(A.admin).post(`/teachers/${r.body.data.id}/invite`);
      expect(inv.status).toBe(200);
      expect(inv.body.data.accountStatus).toBe('active');
      expect((await as(A.admin).post(`/teachers/${r.body.data.id}/invite`)).body.error.code).toBe(
        'ALREADY_INVITED',
      );
    });

    it('the plan limit on teachers is enforced', async () => {
      const T = await createTenant('teachLimit');
      const used = (
        await pool.query('select count(*)::int c from teachers where organization_id = $1', [
          T.orgId,
        ])
      ).rows[0].c as number;
      for (let i = used; i < 10; i++)
        await pool.query(
          `insert into teachers (organization_id, employee_code, full_name) values ($1, $2, 'Filler')`,
          [T.orgId, code('F')],
        );
      const r = await as(T.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Eleventh',
        invite: false,
      });
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });
  });

  describe('scope decides what a teacher can work on', () => {
    it('assigning subjects, a course or a unit opens exactly that content; clearing it closes it', async () => {
      const t = await invite(A);
      const subjects = async () =>
        (await as(t.userId).get('/subjects')).body.data.items.map((s: any) => s.id).sort();
      expect(await subjects()).toEqual([]);

      const r = await as(A.owner).put(`/teachers/${t.id}/scopes`, {
        scopes: [{ scopeType: 'subject', scopeId: A.subject1 }],
      });
      expect(r.status).toBe(200);
      expect(r.body.data.scopes).toEqual([
        expect.objectContaining({
          scopeType: 'subject',
          scopeId: A.subject1,
          name: 'Subject 1',
          active: true,
        }),
      ]);
      expect(await subjects()).toEqual([A.subject1]);
      expect(
        (await as(t.userId).post('/topics', { subjectId: A.subject2, name: 'x' })).status,
      ).toBe(404);

      // a unit covers every subject placed on it (and on its sub-units)
      await as(A.owner).put(`/teachers/${t.id}/scopes`, {
        scopes: [{ scopeType: 'academic_unit', scopeId: A.unitId }],
      });
      expect(await subjects()).toEqual([A.subject1, A.subject2].sort());
      expect((await as(A.owner).get(`/teachers/${t.id}`)).body.data.scopeCount).toBe(1);

      await as(A.owner).put(`/teachers/${t.id}/scopes`, { scopes: [] });
      expect(await subjects()).toEqual([]);
    });

    it('rejects targets of another college or deleted ones, and keeps the old scope', async () => {
      const t = await invite(A);
      await as(A.owner).put(`/teachers/${t.id}/scopes`, {
        scopes: [{ scopeType: 'subject', scopeId: A.subject1 }],
      });
      const r = await as(A.owner).put(`/teachers/${t.id}/scopes`, {
        scopes: [
          { scopeType: 'subject', scopeId: B.subject1 },
          { scopeType: 'course', scopeId: A.courseId },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({
        code: 'INVALID_SCOPE_TARGET',
        details: { missing: [B.subject1] },
      });
      expect((await as(A.owner).get(`/teachers/${t.id}`)).body.data.scopes).toHaveLength(1);
    });

    it('a teacher without a login has no scope yet', async () => {
      const r = await as(A.owner).post('/teachers', {
        employeeCode: code(),
        fullName: 'Paper Only',
        invite: false,
      });
      const s = await as(A.owner).put(`/teachers/${r.body.data.id}/scopes`, {
        scopes: [{ scopeType: 'subject', scopeId: A.subject1 }],
      });
      expect(s.status).toBe(400);
      expect(s.body.error.code).toBe('TEACHER_HAS_NO_LOGIN');
    });
  });

  describe('deactivating and removing', () => {
    it('inactive locks the login out; active lets it back in', async () => {
      const t = await invite(A);
      expect((await as(t.userId).get('/topics')).status).toBe(200);
      const off = await as(A.admin).patch(`/teachers/${t.id}`, { status: 'inactive' });
      expect(off.body.data).toMatchObject({ status: 'inactive', accountStatus: 'suspended' });
      expect((await as(t.userId).get('/topics')).status).toBe(403);
      const on = await as(A.admin).patch(`/teachers/${t.id}`, { status: 'active' });
      expect(on.body.data.accountStatus).toBe('active');
      expect((await as(t.userId).get('/topics')).status).toBe(200);
    });

    it('the sign-in e-mail of a linked teacher cannot be changed here', async () => {
      const t = await invite(A);
      const r = await as(A.owner).patch(`/teachers/${t.id}`, { email: email('other') });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('EMAIL_LOCKED');
      expect(
        (await as(A.owner).patch(`/teachers/${t.id}`, { email: t.email, fullName: 'Same Mail' }))
          .status,
      ).toBe(200);
    });

    it('removal: record soft-deleted, membership removed, scope cleared, history kept', async () => {
      const t = await invite(A);
      await as(A.owner).put(`/teachers/${t.id}/scopes`, {
        scopes: [{ scopeType: 'subject', scopeId: A.subject1 }],
      });
      expect((await as(A.owner).del(`/teachers/${t.id}`)).status).toBe(200);
      expect((await as(A.owner).get(`/teachers/${t.id}`)).status).toBe(404);
      expect((await as(t.userId).get('/topics')).status).toBe(403);
      const db = await pool.query(
        `select (select status from organization_members where organization_id = $1 and user_id = $2) as member,
                (select count(*)::int from user_scopes where organization_id = $1 and user_id = $2) as scopes,
                (select deleted_at is not null from teachers where id = $3) as deleted`,
        [A.orgId, t.userId, t.id],
      );
      expect(db.rows[0]).toEqual({ member: 'removed', scopes: 0, deleted: true });
    });
  });

  describe('tenant isolation through the API', () => {
    it("College A cannot see or change College B's teachers", async () => {
      const tb = await invite(B);
      expect((await as(A.owner).get(`/teachers/${tb.id}`)).status).toBe(404);
      expect((await as(A.owner).patch(`/teachers/${tb.id}`, { fullName: 'pwned' })).status).toBe(
        404,
      );
      expect((await as(A.owner).put(`/teachers/${tb.id}/scopes`, { scopes: [] })).status).toBe(404);
      expect((await as(A.owner).post(`/teachers/${tb.id}/invite`)).status).toBe(404);
      expect((await as(A.owner).del(`/teachers/${tb.id}`)).status).toBe(404);
      const row = await pool.query('select full_name, deleted_at from teachers where id = $1', [
        tb.id,
      ]);
      expect(row.rows[0]).toEqual({ full_name: 'New Teacher', deleted_at: null });
      const ids = (await as(A.owner).get('/teachers?pageSize=100')).body.data.items.map(
        (x: any) => x.id,
      );
      expect(ids).not.toContain(tb.id);
    });

    it('inviting a member of another college as a teacher here does not touch their other membership', async () => {
      const e = await emailOf(B.teacher1);
      const t = await invite(A, { email: e });
      expect(t.userId).toBe(B.teacher1); // same person, now also a teacher in A
      expect(await rolesOf(B, B.teacher1)).toEqual(['TEACHER']);
      const bScopes = await pool.query(
        'select count(*)::int c from user_scopes where organization_id = $1 and user_id = $2',
        [B.orgId, B.teacher1],
      );
      expect(bScopes.rows[0].c).toBe(1);
    });
  });
});
