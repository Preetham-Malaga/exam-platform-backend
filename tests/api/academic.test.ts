// Phase 8: academic structure API (levels, units, courses, subjects, topics) on the real app + real PostgreSQL.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

const code = (p = 'X') => `${p}${randomUUID().slice(0, 8)}`;

describe.skipIf(!DATABASE_TEST_URL)('Academic structure API (real app + real PostgreSQL)', () => {
  let app: FastifyInstance;
  let A: Tenant;
  let B: Tenant;
  const as = (id?: string) => new Client(app, id);
  /** Level ids of a tenant, top first (engineering: Program, Branch, Year, Semester). */
  const levels = async (T: Tenant) =>
    (
      await pool.query(
        'select id from academic_levels where organization_id = $1 order by position',
        [T.orgId],
      )
    ).rows.map((r) => r.id as string);

  beforeAll(async () => {
    app = await makeApp();
    A = await createTenant('acadA');
    B = await createTenant('acadB');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('permission matrix: owner, admin, teacher, student', () => {
    // [method, path, body, expected status per role: owner, admin, teacher, student]
    const matrix: Array<
      [string, string, (T: Tenant, lv: string[]) => unknown, [number, number, number, number]]
    > = [
      ['GET', '/academic-levels', () => undefined, [200, 200, 200, 200]],
      ['POST', '/academic-levels', () => ({ name: code('Level ') }), [201, 201, 403, 403]],
      ['GET', '/academic-units', () => undefined, [200, 200, 200, 200]],
      ['GET', '/academic-units/tree', () => undefined, [200, 200, 200, 200]],
      [
        'POST',
        '/academic-units',
        (T, lv) => ({ levelId: lv[1], parentId: T.unitId, code: code('U'), name: 'Branch' }),
        [201, 201, 403, 403],
      ],
      ['GET', '/courses', () => undefined, [200, 200, 200, 403]],
      ['POST', '/courses', () => ({ code: code('C'), name: 'Course' }), [201, 201, 403, 403]],
      ['PATCH', '/courses/:course', () => ({ name: 'Renamed' }), [200, 200, 403, 403]],
      ['GET', '/subjects', () => undefined, [200, 200, 200, 403]],
      ['POST', '/subjects', () => ({ code: code('S'), name: 'Subject' }), [201, 201, 403, 403]],
      ['PATCH', '/subjects/:subject1', () => ({ name: 'Renamed' }), [200, 200, 403, 403]],
      ['GET', '/topics', () => undefined, [200, 200, 200, 403]],
      [
        'POST',
        '/topics',
        (T) => ({ subjectId: T.subject1, name: code('Topic ') }),
        [201, 201, 201, 403],
      ],
    ];
    let T: Tenant;
    let lv: string[];
    beforeAll(async () => {
      T = await createTenant('acadMatrix');
      lv = await levels(T);
    });
    const url = (p: string, T: Tenant) =>
      p.replace(':course', T.courseId).replace(':subject1', T.subject1);

    for (const [method, path, body, expected] of matrix) {
      it(`${method} ${path}`, async () => {
        const results: number[] = [];
        for (const u of [T.owner, T.admin, T.teacher1, T.student])
          results.push((await as(u).call(method as 'GET', url(path, T), body(T, lv))).status);
        expect(results, 'owner, admin, teacher, student').toEqual(expected);
      });
    }
    it('unauthenticated callers get 401 on all of them', async () => {
      for (const [method, path, body] of matrix)
        expect(
          (await as().call(method as 'GET', url(path, T), body(T, lv))).status,
          `${method} ${path}`,
        ).toBe(401);
    });
  });

  describe('levels', () => {
    it('lists the default levels of the institution type in order, with unit counts', async () => {
      const r = await as(A.owner).get('/academic-levels');
      expect(r.status).toBe(200);
      expect(r.body.data.items.map((l: any) => l.name)).toEqual([
        'Program',
        'Branch',
        'Year',
        'Semester',
      ]);
      expect(r.body.data.items[0].unitCount).toBeGreaterThanOrEqual(1);
    });

    it('adds a level at the bottom, renames it, and deletes it while unused', async () => {
      const T = await createTenant('acadLevels');
      const c = await as(T.owner).post('/academic-levels', { name: 'Lab Group' });
      expect(c.status).toBe(201);
      expect(c.body.data).toMatchObject({ name: 'Lab Group', code: 'lab_group', position: 5 });
      const id = c.body.data.id;
      const u = await as(T.owner).patch(`/academic-levels/${id}`, { name: 'Lab Batch' });
      expect(u.body.data.name).toBe('Lab Batch');
      expect((await as(T.owner).del(`/academic-levels/${id}`)).status).toBe(200);
      expect((await as(T.owner).get('/academic-levels')).body.data.items).toHaveLength(4);
    });

    it('refuses to delete a level that units use', async () => {
      const [program] = await levels(A);
      const r = await as(A.owner).del(`/academic-levels/${program}`);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('LEVEL_IN_USE');
    });

    it('reorders levels, but never so that a unit ends up above its parent', async () => {
      const T = await createTenant('acadOrder');
      const lv = await levels(T); // Program, Branch, Year, Semester; U1 is a Program
      // no unit has a parent yet: any order is fine
      const swapped = [lv[1], lv[0], lv[2], lv[3]];
      const r = await as(T.owner).put('/academic-levels/order', { levelIds: swapped });
      expect(r.status).toBe(200);
      expect(r.body.data.items.map((l: any) => l.id)).toEqual(swapped);
      // Order is now Branch, Program, Year, Semester. U1 is a Program (position 2); a Year child (position 3) is valid.
      const child = await as(T.owner).post('/academic-units', {
        levelId: lv[2],
        parentId: T.unitId,
        code: 'Y1',
        name: 'Year 1',
      });
      expect(child.status).toBe(201);
      // Putting Year above Program would place that child above its parent: refused, the order stays as it was.
      const bad = await as(T.owner).put('/academic-levels/order', {
        levelIds: [lv[2], lv[1], lv[0], lv[3]],
      });
      expect(bad.status).toBe(409);
      expect(bad.body.error.code).toBe('LEVEL_ORDER_CONFLICT');
      expect(
        (await as(T.owner).get('/academic-levels')).body.data.items.map((l: any) => l.id),
      ).toEqual(swapped);
    });

    it('reorder must name every level exactly once', async () => {
      const lv = await levels(A);
      for (const levelIds of [
        lv.slice(0, 3),
        [lv[0], lv[0], lv[1], lv[2]],
        [...lv.slice(0, 3), randomUUID()],
      ])
        expect((await as(A.owner).put('/academic-levels/order', { levelIds })).status).toBe(400);
    });
  });

  describe('units: the tree follows the level order', () => {
    it('builds Program > Branch > Year and returns it from /tree', async () => {
      const [, branch, year] = await levels(A);
      const b = await as(A.owner).post('/academic-units', {
        levelId: branch,
        parentId: A.unitId,
        code: code('EEE'),
        name: 'EEE',
      });
      expect(b.status).toBe(201);
      expect(b.body.data).toMatchObject({ levelName: 'Branch', parentId: A.unitId });
      const y = await as(A.admin).post('/academic-units', {
        levelId: year,
        parentId: b.body.data.id,
        code: code('Y2'),
        name: 'Year 2',
      });
      expect(y.status).toBe(201);
      const tree = await as(A.teacher1).get('/academic-units/tree');
      expect(tree.status).toBe(200);
      const ids = tree.body.data.units.map((u: any) => u.id);
      expect(ids).toEqual(expect.arrayContaining([A.unitId, b.body.data.id, y.body.data.id]));
      expect(tree.body.data.levels).toHaveLength(4);
      const children = await as(A.owner).get(`/academic-units?parentId=${A.unitId}`);
      expect(children.body.data.items.map((u: any) => u.id)).toContain(b.body.data.id);
    });

    it('refuses a child on the same or a higher level than its parent', async () => {
      const [program] = await levels(A);
      const r = await as(A.owner).post('/academic-units', {
        levelId: program,
        parentId: A.unitId,
        code: code('P'),
        name: 'Program under Program',
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_UNIT_LEVEL');
    });

    it('refuses to move a unit so that its existing children would sit above it', async () => {
      const [, branch, year, semester] = await levels(A);
      const parent = await as(A.owner).post('/academic-units', {
        levelId: branch,
        parentId: A.unitId,
        code: code('B'),
        name: 'Branch',
      });
      await as(A.owner).post('/academic-units', {
        levelId: year,
        parentId: parent.body.data.id,
        code: code('Y'),
        name: 'Year',
      });
      const r = await as(A.owner).patch(`/academic-units/${parent.body.data.id}`, {
        levelId: semester,
        parentId: null,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_UNIT_LEVEL');
      expect(
        (
          await as(A.owner).patch(`/academic-units/${parent.body.data.id}`, {
            parentId: parent.body.data.id,
          })
        ).body.error.code,
      ).toBe('INVALID_PARENT_UNIT');
    });

    it('a parent from another college is invalid and reveals nothing', async () => {
      const [, branch] = await levels(A);
      const r = await as(A.owner).post('/academic-units', {
        levelId: branch,
        parentId: B.unitId,
        code: code('X'),
        name: 'Hijack',
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_PARENT_UNIT');
      const lvB = await levels(B);
      expect(
        (await as(A.owner).post('/academic-units', { levelId: lvB[0], code: code('X'), name: 'X' }))
          .status,
      ).toBe(404);
    });

    it('refuses to delete a unit that is still used, then soft-deletes it and frees its code', async () => {
      const used = await as(A.owner).del(`/academic-units/${A.unitId}`);
      expect(used.status).toBe(409);
      expect(used.body.error.code).toBe('UNIT_IN_USE');
      expect(used.body.error.details).toMatchObject({ courses: 1, students: 2 });

      const [program] = await levels(A);
      const c = code('TMP');
      const u = await as(A.owner).post('/academic-units', {
        levelId: program,
        code: c,
        name: 'Temp',
      });
      expect((await as(A.owner).del(`/academic-units/${u.body.data.id}`)).status).toBe(200);
      expect((await as(A.owner).get(`/academic-units/${u.body.data.id}`)).status).toBe(404);
      const row = await pool.query('select deleted_at from academic_units where id = $1', [
        u.body.data.id,
      ]);
      expect(row.rows[0].deleted_at).not.toBeNull(); // history kept
      expect(
        (await as(A.owner).post('/academic-units', { levelId: program, code: c, name: 'Again' }))
          .status,
      ).toBe(201);
    });

    it('duplicate active codes are refused per organization, but another college may reuse them', async () => {
      const [program] = await levels(A);
      const [programB] = await levels(B);
      const c = code('DUP');
      expect(
        (await as(A.owner).post('/academic-units', { levelId: program, code: c, name: 'One' }))
          .status,
      ).toBe(201);
      const dup = await as(A.owner).post('/academic-units', {
        levelId: program,
        code: c,
        name: 'Two',
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('DUPLICATE');
      expect(
        (await as(B.owner).post('/academic-units', { levelId: programB, code: c, name: 'B' }))
          .status,
      ).toBe(201);
    });

    it('rejects unknown fields (no organizationId or deleted_at smuggling)', async () => {
      const [program] = await levels(A);
      const r = await as(A.owner).post('/academic-units', {
        levelId: program,
        code: code('S'),
        name: 'S',
        organizationId: B.orgId,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('courses and subjects', () => {
    it('creates a course under a unit and a subject under the course', async () => {
      const c = await as(A.admin).post('/courses', {
        code: code('BT'),
        name: 'B.Tech',
        academicUnitId: A.unitId,
      });
      expect(c.status).toBe(201);
      expect(c.body.data).toMatchObject({
        academicUnitName: 'Unit 1',
        subjectCount: 0,
        status: 'active',
      });
      const s = await as(A.admin).post('/subjects', {
        code: code('EM'),
        name: 'Electrical Machines',
        courseId: c.body.data.id,
        academicUnitId: A.unitId,
      });
      expect(s.status).toBe(201);
      expect(s.body.data).toMatchObject({ courseName: 'B.Tech', topicCount: 0 });
      const list = await as(A.admin).get(`/subjects?courseId=${c.body.data.id}`);
      expect(list.body.data.items.map((x: any) => x.id)).toEqual([s.body.data.id]);
      expect((await as(A.admin).get(`/courses/${c.body.data.id}`)).body.data.subjectCount).toBe(1);
    });

    it('searches and paginates', async () => {
      const r = await as(A.owner).get('/subjects?search=Subject%201&pageSize=1');
      expect(r.status).toBe(200);
      expect(r.body.data.pagination).toMatchObject({ page: 1, pageSize: 1 });
      expect(r.body.data.items[0].name).toBe('Subject 1');
    });

    it('refuses links to a unit or course of another college', async () => {
      expect(
        (
          await as(A.owner).post('/courses', {
            code: code('C'),
            name: 'X',
            academicUnitId: B.unitId,
          })
        ).status,
      ).toBe(404);
      expect(
        (await as(A.owner).post('/subjects', { code: code('S'), name: 'X', courseId: B.courseId }))
          .status,
      ).toBe(404);
      expect(
        (await as(A.owner).patch(`/subjects/${A.subject1}`, { courseId: B.courseId })).status,
      ).toBe(404);
    });

    it('refuses to delete a course with subjects and a subject with questions', async () => {
      const course = await as(A.owner).del(`/courses/${A.courseId}`);
      expect(course.status).toBe(409);
      expect(course.body.error.code).toBe('COURSE_IN_USE');
      const subject = await as(A.owner).del(`/subjects/${A.subject1}`);
      expect(subject.status).toBe(409);
      expect(subject.body.error).toMatchObject({
        code: 'SUBJECT_IN_USE',
        details: { questions: 1 },
      });
    });

    it('soft-deletes an empty subject and course', async () => {
      const c = await as(A.owner).post('/courses', { code: code('E'), name: 'Empty' });
      const s = await as(A.owner).post('/subjects', {
        code: code('E'),
        name: 'Empty',
        courseId: c.body.data.id,
      });
      expect((await as(A.owner).del(`/subjects/${s.body.data.id}`)).status).toBe(200);
      expect((await as(A.owner).del(`/courses/${c.body.data.id}`)).status).toBe(200);
      expect((await as(A.owner).get(`/courses/${c.body.data.id}`)).status).toBe(404);
    });

    it('teachers see only the subjects and courses in their scope', async () => {
      const subjects = (await as(A.teacher1).get('/subjects')).body.data.items.map(
        (s: any) => s.id,
      );
      expect(subjects).toEqual([A.subject1]);
      expect((await as(A.teacher1).get(`/subjects/${A.subject2}`)).status).toBe(404);
      const courses = (await as(A.teacher1).get('/courses')).body.data.items.map((c: any) => c.id);
      expect(courses).toEqual([A.courseId]); // through subject1's course
    });
  });

  describe('topics', () => {
    it('a teacher manages topics of their own subject only', async () => {
      const t = await as(A.teacher1).post('/topics', {
        subjectId: A.subject1,
        name: 'Transformers',
      });
      expect(t.status).toBe(201);
      expect(t.body.data).toMatchObject({ subjectId: A.subject1, subjectName: 'Subject 1' });
      expect(t.body.data.position).toBeGreaterThanOrEqual(1);
      const p = await as(A.teacher1).patch(`/topics/${t.body.data.id}`, { name: 'Transformers I' });
      expect(p.body.data.name).toBe('Transformers I');

      const out = await as(A.teacher1).post('/topics', { subjectId: A.subject2, name: 'Not mine' });
      expect(out.status).toBe(404);
      const theirs = await as(A.teacher2).post('/topics', {
        subjectId: A.subject2,
        name: 'Theirs',
      });
      expect(theirs.status).toBe(201);
      expect(
        (await as(A.teacher1).patch(`/topics/${theirs.body.data.id}`, { name: 'x' })).status,
      ).toBe(404);
      expect((await as(A.teacher1).del(`/topics/${theirs.body.data.id}`)).status).toBe(404);
      const seen = (await as(A.teacher1).get('/topics')).body.data.items.map(
        (x: any) => x.subjectId,
      );
      expect(new Set(seen)).toEqual(new Set([A.subject1]));

      expect((await as(A.teacher1).del(`/topics/${t.body.data.id}`)).status).toBe(200);
    });

    it('same topic name twice in one subject is a duplicate', async () => {
      const name = code('Dup topic ');
      expect((await as(A.owner).post('/topics', { subjectId: A.subject1, name })).status).toBe(201);
      expect(
        (await as(A.owner).post('/topics', { subjectId: A.subject1, name: name.toUpperCase() }))
          .status,
      ).toBe(409);
    });

    it('refuses to delete a topic that a question uses', async () => {
      const t = await as(A.owner).post('/topics', { subjectId: A.subject1, name: code('Used ') });
      await pool.query('update questions set topic_id = $1 where id = $2', [t.body.data.id, A.q1]);
      try {
        const r = await as(A.owner).del(`/topics/${t.body.data.id}`);
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('TOPIC_IN_USE');
      } finally {
        await pool.query('update questions set topic_id = null where id = $1', [A.q1]);
      }
    });
  });

  describe('tenant isolation through the API', () => {
    it("College A cannot read, change or delete College B's academic records", async () => {
      const topicB = (await as(B.owner).post('/topics', { subjectId: B.subject1, name: 'B only' }))
        .body.data.id;
      const lvB = await levels(B);
      const targets: Array<[string, string]> = [
        ['academic-units', B.unitId],
        ['courses', B.courseId],
        ['subjects', B.subject1],
      ];
      for (const [res, id] of targets) {
        expect((await as(A.owner).get(`/${res}/${id}`)).status, `GET ${res}`).toBe(404);
        expect(
          (await as(A.owner).patch(`/${res}/${id}`, { name: 'pwned' })).status,
          `PATCH ${res}`,
        ).toBe(404);
      }
      expect((await as(A.owner).patch(`/topics/${topicB}`, { name: 'pwned' })).status).toBe(404);
      expect(
        (await as(A.owner).patch(`/academic-levels/${lvB[0]}`, { name: 'pwned' })).status,
      ).toBe(404);
      // empty B records so the in-use check passes and only isolation can stop the delete
      const emptyCourse = (await as(B.owner).post('/courses', { code: code('E'), name: 'E' })).body
        .data.id;
      expect((await as(A.owner).del(`/courses/${emptyCourse}`)).status).toBe(404);
      expect((await as(A.owner).del(`/topics/${topicB}`)).status).toBe(404);
      expect((await as(A.owner).del(`/academic-levels/${lvB[3]}`)).status).toBe(404);

      const names = await pool.query(
        `select (select count(*)::int from courses where organization_id = $1 and deleted_at is null and id = $2) as course,
                (select count(*)::int from topics where id = $3 and deleted_at is null) as topic,
                (select count(*)::int from academic_levels where organization_id = $1) as levels,
                (select count(*)::int from subjects where organization_id = $1 and name = 'pwned') as pwned`,
        [B.orgId, emptyCourse, topicB],
      );
      expect(names.rows[0]).toEqual({ course: 1, topic: 1, levels: 4, pwned: 0 });
    });

    it('lists contain only the caller organization', async () => {
      for (const res of ['academic-units', 'courses', 'subjects', 'topics']) {
        const ids = (await as(B.owner).get(`/${res}?pageSize=100`)).body.data.items.map(
          (x: any) => x.id,
        );
        const own = await pool.query(
          `select count(*)::int as c from public.${res.replace('-', '_')} where organization_id = $1 and id = any($2)`,
          [B.orgId, ids],
        );
        expect(own.rows[0].c, res).toBe(ids.length);
      }
    });
  });
});
