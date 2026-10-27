// Phase 10: student management (records, unit placement, import, invitation, activation/removal) on the real app + DB.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

const roll = (p = 'R') => `${p}${randomUUID().slice(0, 8)}`;
const email = (p = 'student') => `${p}.${randomUUID()}@test.local`;

describe.skipIf(!DATABASE_TEST_URL)('Students API (real app + real PostgreSQL)', () => {
  let app: FastifyInstance;
  let A: Tenant;
  let B: Tenant;
  const as = (id?: string) => new Client(app, id);
  const emailOf = async (userId: string) =>
    (await pool.query('select email from auth.users where id = $1', [userId])).rows[0]
      .email as string;
  const level = async (T: Tenant, position: number) =>
    (
      await pool.query(
        'select id from academic_levels where organization_id = $1 and position = $2',
        [T.orgId, position],
      )
    ).rows[0].id as string;
  const addStudent = async (T: Tenant, over: Record<string, unknown> = {}) => {
    const r = await as(T.owner).post('/students', {
      rollNumber: roll(),
      fullName: 'New Student',
      ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data;
  };

  beforeAll(async () => {
    app = await makeApp();
    A = await createTenant('studA');
    B = await createTenant('studB');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('permission matrix: owner, admin, teacher, student', () => {
    let T: Tenant;
    beforeAll(async () => {
      T = await createTenant('studMatrix');
    });
    const matrix: Array<[string, string, () => unknown, [number, number, number, number]]> = [
      ['GET', '/students', () => undefined, [200, 200, 200, 403]], // teachers may read students
      ['GET', '/students/:id', () => undefined, [200, 200, 200, 403]],
      [
        'POST',
        '/students',
        () => ({ rollNumber: roll(), fullName: 'Matrix' }),
        [201, 201, 403, 403],
      ],
      ['PATCH', '/students/:id', () => ({ phone: '123' }), [200, 200, 403, 403]],
      [
        'POST',
        '/students/import',
        () => ({ rows: [{ rollNumber: roll(), fullName: 'Dry Run' }], dryRun: true }),
        [200, 200, 403, 403],
      ],
    ];
    for (const [method, path, body, expected] of matrix)
      it(`${method} ${path}`, async () => {
        const results: number[] = [];
        for (const u of [T.owner, T.admin, T.teacher1, T.student])
          results.push(
            (await as(u).call(method as 'GET', path.replace(':id', T.studentId), body())).status,
          );
        expect(results, 'owner, admin, teacher, student').toEqual(expected);
      });
    it('unauthenticated callers get 401', async () => {
      for (const [method, path, body] of matrix)
        expect(
          (await as().call(method as 'GET', path.replace(':id', T.studentId), body())).status,
        ).toBe(401);
    });
  });

  describe('adding and inviting', () => {
    it('adds a student on a unit and invites them: STUDENT login linked to the record', async () => {
      const e = email();
      const s = await addStudent(A, { email: e, academicUnitId: A.unitId, invite: true });
      expect(s).toMatchObject({
        academicUnitId: A.unitId,
        academicUnitName: 'Unit 1',
        accountStatus: 'active',
      });
      const me = await as(s.userId).get('/me');
      expect(me.body.data).toMatchObject({ roles: ['STUDENT'], studentId: s.id });
    });

    it('records can wait for their invitation; an e-mail is needed to invite', async () => {
      const s = await addStudent(A);
      expect(s).toMatchObject({ userId: null, accountStatus: null });
      expect((await as(A.owner).post(`/students/${s.id}/invite`)).body.error.code).toBe(
        'EMAIL_REQUIRED',
      );
      await as(A.owner).patch(`/students/${s.id}`, { email: email('later') });
      const inv = await as(A.admin).post(`/students/${s.id}/invite`);
      expect(inv.body.data.accountStatus).toBe('active');
      expect((await as(A.admin).post(`/students/${s.id}/invite`)).body.error.code).toBe(
        'ALREADY_INVITED',
      );
    });

    it('never gives a teacher a second (student) role', async () => {
      const r = await as(A.owner).post('/students', {
        rollNumber: roll(),
        fullName: 'Teacher One',
        email: await emailOf(A.teacher1),
        invite: true,
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ALREADY_MEMBER');
    });

    it('roll numbers are unique per college (active records only), another college may reuse them', async () => {
      const r = roll('DUP');
      await addStudent(A, { rollNumber: r });
      expect(
        (await as(A.owner).post('/students', { rollNumber: r, fullName: 'Again' })).status,
      ).toBe(409);
      expect(
        (await as(B.owner).post('/students', { rollNumber: r, fullName: 'Other college' })).status,
      ).toBe(201);
    });

    it('a unit of another college cannot be used', async () => {
      expect(
        (
          await as(A.owner).post('/students', {
            rollNumber: roll(),
            fullName: 'Xavier',
            academicUnitId: B.unitId,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('finding students by unit', () => {
    it('a unit filter includes every unit below it; "unplaced" finds students without a unit', async () => {
      const T = await createTenant('studTree');
      const branch = (
        await as(T.owner).post('/academic-units', {
          levelId: await level(T, 2),
          parentId: T.unitId,
          code: 'EEE',
          name: 'EEE',
        })
      ).body.data.id;
      const deep = await addStudent(T, { academicUnitId: branch });
      const loose = await addStudent(T);
      const ids = async (q: string) =>
        (await as(T.owner).get(`/students?pageSize=100&${q}`)).body.data.items
          .map((s: any) => s.id)
          .sort();
      expect(await ids(`academicUnitId=${T.unitId}`)).toEqual(
        [T.studentId, T.student2Id, deep.id].sort(),
      );
      expect(await ids(`academicUnitId=${branch}`)).toEqual([deep.id]);
      expect(await ids('unplaced=true')).toEqual([loose.id]);
      expect(await ids('search=Student%20One')).toEqual([T.studentId]);
    });
  });

  describe('import', () => {
    it('imports valid rows and reports every bad row with its reason', async () => {
      const T = await createTenant('studImport');
      const ok1 = roll('I');
      const ok2 = roll('I');
      const rows = [
        { rollNumber: ok1, fullName: 'Asha Verma', email: 'ASHA@College.test', unitCode: 'u1' }, // unit code ignores case
        { rollNumber: ok2, fullName: 'Ravi Kumar', email: '', phone: '', unitCode: '' }, // blank cells = no value
        { rollNumber: ok1, fullName: 'Copy' }, // duplicate inside the file
        { rollNumber: 'R1', fullName: 'Existing' }, // already in the college
        { rollNumber: roll('I'), fullName: 'Bad Mail', email: 'not-an-email' },
        { rollNumber: roll('I'), fullName: 'Lost', unitCode: 'NOPE' },
        { rollNumber: '', fullName: 'No Roll' },
        'not even an object',
      ];
      const r = await as(T.admin).post('/students/import', { rows });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ total: 8, created: 2, dryRun: false });
      expect(r.body.data.failed.map((f: any) => [f.row, f.code])).toEqual([
        [3, 'DUPLICATE_IN_FILE'],
        [4, 'DUPLICATE'],
        [5, 'INVALID_ROW'],
        [6, 'UNKNOWN_UNIT'],
        [7, 'INVALID_ROW'],
        [8, 'INVALID_ROW'],
      ]);
      expect(r.body.data.failed[1].message).toBe('A student with this roll number already exists.');
      const saved = await pool.query(
        `select roll_number, email, phone, academic_unit_id from students where organization_id = $1 and roll_number = any($2) order by roll_number`,
        [T.orgId, [ok1, ok2]],
      );
      expect(saved.rows).toEqual(
        [
          { roll_number: ok1, email: 'asha@college.test', phone: null, academic_unit_id: T.unitId },
          { roll_number: ok2, email: null, phone: null, academic_unit_id: null },
        ].sort((a, b) => a.roll_number.localeCompare(b.roll_number)),
      );
    });

    it('dryRun reports the same result and saves nothing', async () => {
      const r1 = roll('D');
      const r = await as(A.owner).post('/students/import', {
        rows: [
          { rollNumber: r1, fullName: 'Dry One' },
          { rollNumber: 'R1', fullName: 'Existing' },
        ],
        dryRun: true,
      });
      expect(r.body.data).toMatchObject({ created: 1, dryRun: true });
      expect(r.body.data.failed.map((f: any) => f.code)).toEqual(['DUPLICATE']);
      expect(
        (await pool.query('select 1 from students where roll_number = $1', [r1])).rowCount,
      ).toBe(0);
    });

    it('stops at the plan limit, row by row', async () => {
      const T = await createTenant('studLimit');
      const used = (
        await pool.query('select count(*)::int c from students where organization_id = $1', [
          T.orgId,
        ])
      ).rows[0].c as number;
      await pool.query(
        `insert into students (organization_id, roll_number, full_name)
         select $1, 'F' || g, 'Filler' from generate_series(1, $2) g`,
        [T.orgId, 98 - used],
      );
      const r = await as(T.owner).post('/students/import', {
        rows: Array.from({ length: 5 }, () => ({ rollNumber: roll('L'), fullName: 'Late Joiner' })),
      });
      expect(r.body.data.created).toBe(2);
      expect(r.body.data.failed.map((f: any) => f.code)).toEqual(
        Array(3).fill('PLAN_LIMIT_REACHED'),
      );
    });

    it('accepts at most 500 rows per request', async () => {
      const rows = Array.from({ length: 501 }, (_, i) => ({
        rollNumber: `X${i}`,
        fullName: 'Too Many',
      }));
      const r = await as(A.owner).post('/students/import', { rows, dryRun: true });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('editing, deactivating, removing', () => {
    it('moves a student to another unit; the sign-in e-mail of a linked student is locked', async () => {
      const s = await addStudent(A, { email: email(), invite: true });
      const [, branchLevel] = [0, await level(A, 2)];
      const unit = (
        await as(A.owner).post('/academic-units', {
          levelId: branchLevel,
          parentId: A.unitId,
          code: roll('U'),
          name: 'Branch X',
        })
      ).body.data.id;
      const moved = await as(A.owner).patch(`/students/${s.id}`, { academicUnitId: unit });
      expect(moved.body.data).toMatchObject({ academicUnitId: unit, academicUnitName: 'Branch X' });
      expect(
        (await as(A.owner).patch(`/students/${s.id}`, { academicUnitId: B.unitId })).status,
      ).toBe(404);
      expect(
        (await as(A.owner).patch(`/students/${s.id}`, { email: email('x') })).body.error.code,
      ).toBe('EMAIL_LOCKED');
    });

    it('inactive locks the login out, active lets it back in', async () => {
      const s = await addStudent(A, { email: email(), invite: true });
      expect((await as(s.userId).get('/academic-levels')).status).toBe(200);
      await as(A.admin).patch(`/students/${s.id}`, { status: 'inactive' });
      expect((await as(s.userId).get('/academic-levels')).status).toBe(403);
      await as(A.admin).patch(`/students/${s.id}`, { status: 'active' });
      expect((await as(s.userId).get('/academic-levels')).status).toBe(200);
    });

    it('removal: soft delete, membership removed, roll number free again', async () => {
      const s = await addStudent(A, { email: email(), invite: true });
      expect((await as(A.owner).del(`/students/${s.id}`)).status).toBe(200);
      expect((await as(A.owner).get(`/students/${s.id}`)).status).toBe(404);
      expect((await as(s.userId).get('/academic-levels')).status).toBe(403);
      const db = await pool.query(
        `select (select status from organization_members where organization_id = $1 and user_id = $2) as member,
                (select deleted_at is not null from students where id = $3) as deleted`,
        [A.orgId, s.userId, s.id],
      );
      expect(db.rows[0]).toEqual({ member: 'removed', deleted: true });
      expect(
        (await as(A.owner).post('/students', { rollNumber: s.rollNumber, fullName: 'Reused' }))
          .status,
      ).toBe(201);
    });
  });

  describe('tenant isolation through the API', () => {
    it("College A cannot see or change College B's students, or import into B's units", async () => {
      for (const [m, path, body] of [
        ['GET', `/students/${B.studentId}`, undefined],
        ['PATCH', `/students/${B.studentId}`, { fullName: 'pwned' }],
        ['POST', `/students/${B.studentId}/invite`, {}],
        ['DELETE', `/students/${B.studentId}`, undefined],
      ] as const)
        expect((await as(A.owner).call(m, path, body)).status, `${m} ${path}`).toBe(404);
      const row = await pool.query('select full_name, deleted_at from students where id = $1', [
        B.studentId,
      ]);
      expect(row.rows[0]).toEqual({ full_name: 'Student One', deleted_at: null });

      const bUnit = (
        await as(B.owner).post('/academic-units', {
          levelId: await level(B, 1),
          code: roll('BU'),
          name: 'B only',
        })
      ).body.data;
      const imp = await as(A.owner).post('/students/import', {
        rows: [{ rollNumber: roll(), fullName: 'Sneaky', unitCode: bUnit.code }],
        dryRun: true,
      });
      expect(imp.body.data.failed.map((f: any) => f.code)).toEqual(['UNKNOWN_UNIT']);

      const ids = (await as(A.owner).get('/students?pageSize=100')).body.data.items.map(
        (s: any) => s.id,
      );
      expect(ids).not.toContain(B.studentId);
      expect(
        (await as(A.owner).get(`/students?academicUnitId=${B.unitId}`)).body.data.items,
      ).toEqual([]);
    });
  });
});
