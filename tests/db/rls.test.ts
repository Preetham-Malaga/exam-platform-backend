import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATABASE_TEST_URL,
  asUser,
  createTenant,
  createUser,
  expectDenied,
  pool,
  type Tenant,
} from './helpers.js';

describe.skipIf(!DATABASE_TEST_URL)('multi-tenant isolation (real PostgreSQL + RLS)', () => {
  let A: Tenant;
  let B: Tenant;

  beforeAll(async () => {
    A = await createTenant('collegeA');
    B = await createTenant('collegeB');
  });
  afterAll(async () => {
    await pool.end();
  });

  const rows = (userId: string, table: string, orgId: string) =>
    asUser(userId, `select id from public.${table} where organization_id = $1`, [orgId]);

  describe('College A cannot read College B', () => {
    for (const [role, pick] of [
      ['owner', (t: Tenant) => t.owner],
      ['admin', (t: Tenant) => t.admin],
      ['teacher', (t: Tenant) => t.teacher1],
      ['student', (t: Tenant) => t.student],
    ] as const) {
      it(`${role} of A sees zero rows of B in every org-owned table`, async () => {
        for (const table of [
          'organizations',
          'organization_members',
          'user_roles',
          'academic_levels',
          'academic_units',
          'courses',
          'subjects',
          'topics',
          'students',
          'teachers',
          'questions',
          'question_options',
          'question_answer_keys',
          'exams',
          'exam_settings',
          'exam_questions',
          'exam_assignments',
          'exam_attempts',
          'attempt_answers',
          'results',
          'leaderboards',
          'subscriptions',
        ]) {
          const idCol = table === 'organizations' ? 'id' : 'organization_id';
          const r = await asUser(pick(A), `select 1 from public.${table} where ${idCol} = $1`, [
            B.orgId,
          ]);
          expect(r, `${role} read ${table} of B`).toHaveLength(0);
        }
      });
    }
    it('A owner still sees A data', async () => {
      expect((await rows(A.owner, 'students', A.orgId)).length).toBe(2);
      expect((await rows(A.owner, 'questions', A.orgId)).length).toBe(2);
    });
  });

  describe('College A cannot write into College B', () => {
    it('cannot insert a student/subject/course into B', async () => {
      await expectDenied(
        A.owner,
        `insert into students (organization_id, roll_number, full_name) values ($1,'X','Intruder')`,
        [B.orgId],
      );
      await expectDenied(
        A.owner,
        `insert into subjects (organization_id, code, name) values ($1,'X','Intruder')`,
        [B.orgId],
      );
      await expectDenied(
        A.admin,
        `insert into courses (organization_id, code, name) values ($1,'X','Intruder')`,
        [B.orgId],
      );
    });
    it('cannot update or delete B rows (zero rows affected)', async () => {
      const upd = await asUser(
        A.owner,
        `update public.students set full_name='hacked' where organization_id=$1 returning id`,
        [B.orgId],
      );
      expect(upd).toHaveLength(0);
      const del = await asUser(
        A.owner,
        `delete from public.courses where organization_id=$1 returning id`,
        [B.orgId],
      );
      expect(del).toHaveLength(0);
      const org = await asUser(
        A.owner,
        `update public.organizations set name='hacked' where id=$1 returning id`,
        [B.orgId],
      );
      expect(org).toHaveLength(0);
    });
    it('cannot move own row to B (organization_id is immutable)', async () => {
      await expectDenied(
        A.owner,
        `update public.courses set organization_id=$1 where organization_id=$2`,
        [B.orgId, A.orgId],
      );
    });
  });

  describe('composite foreign keys block cross-organization references', () => {
    it('a subject in A cannot reference a course of B', async () => {
      await expect(
        pool.query(
          `insert into subjects (organization_id, course_id, code, name) values ($1,$2,'XREF','x')`,
          [A.orgId, B.courseId],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
    it('a question in A cannot reference a subject of B', async () => {
      await expect(
        pool.query(
          `insert into questions (organization_id, subject_id, question_type, question_text) values ($1,$2,'multiple_choice','x')`,
          [A.orgId, B.subject1],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
    it('an exam in A cannot use a question of B', async () => {
      await expect(
        pool.query(
          `insert into exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,9)`,
          [A.orgId, A.examId, B.q1],
        ),
      ).rejects.toThrow();
    });
    it('exam assignment target must belong to the same organization', async () => {
      const e = (
        await pool.query(
          `insert into exams (organization_id, name, exam_code, duration_minutes) values ($1,'x','XA',10) returning id`,
          [A.orgId],
        )
      ).rows[0].id;
      await expect(
        pool.query(
          `insert into exam_assignments (organization_id, exam_id, target_type, target_id) values ($1,$2,'student',$3)`,
          [A.orgId, e, B.studentId],
        ),
      ).rejects.toThrow(/INVALID_ASSIGNMENT_TARGET/);
    });
  });

  describe('teacher scope', () => {
    it('teacher1 sees only subject1 (and its questions)', async () => {
      const subjects = await asUser(A.teacher1, 'select id from public.subjects');
      expect(subjects.map((s) => s.id)).toEqual([A.subject1]);
      const qs = await asUser(A.teacher1, 'select id from public.questions');
      expect(qs.map((q) => q.id)).toEqual([A.q1]);
    });
    it("teacher1 cannot read teacher2's question options or answer keys", async () => {
      expect(
        await asUser(A.teacher1, 'select 1 from public.question_options where question_id=$1', [
          A.q2,
        ]),
      ).toHaveLength(0);
      expect(
        await asUser(A.teacher1, 'select 1 from public.question_answer_keys where question_id=$1', [
          A.q2,
        ]),
      ).toHaveLength(0);
    });
    it("teacher1 cannot insert a question into teacher2's subject", async () => {
      await expectDenied(
        A.teacher1,
        `insert into questions (organization_id, subject_id, question_type, question_text) values ($1,$2,'multiple_choice','sneaky')`,
        [A.orgId, A.subject2],
      );
    });
    it("teacher1 cannot update or delete teacher2's question", async () => {
      expect(
        await asUser(
          A.teacher1,
          `update public.questions set question_text='x' where id=$1 returning id`,
          [A.q2],
        ),
      ).toHaveLength(0);
      expect(
        await asUser(A.teacher1, `delete from public.questions where id=$1 returning id`, [A.q2]),
      ).toHaveLength(0);
    });
    it('teacher1 can create a draft question in own subject', async () => {
      const r = await asUser(
        A.teacher1,
        `insert into questions (organization_id, subject_id, question_type, question_text) values ($1,$2,'true_false','ok') returning id, created_by`,
        [A.orgId, A.subject1],
      );
      expect(r).toHaveLength(1);
      expect(r[0]!.created_by).toBe(A.teacher1);
    });
    it('teacher cannot put a question outside their scope into an exam', async () => {
      const e = (
        await asUser(
          A.teacher1,
          `insert into exams (organization_id, name, exam_code, duration_minutes, created_by) values ($1,'T1 exam','T1E',20,$2) returning id`,
          [A.orgId, A.teacher1],
        )
      )[0]!.id as string;
      await expectDenied(
        A.teacher1,
        `insert into exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,1)`,
        [A.orgId, e, A.q2],
      );
    });
    it("teacher cannot see another teacher's exam", async () => {
      expect(
        await asUser(A.teacher2, `select 1 from public.exams where created_by = $1`, [A.teacher1]),
      ).toHaveLength(0);
    });
  });

  describe('students', () => {
    it('cannot read questions, options or answer keys', async () => {
      expect(await asUser(A.student, 'select 1 from public.questions')).toHaveLength(0);
      expect(await asUser(A.student, 'select 1 from public.question_options')).toHaveLength(0);
      expect(await asUser(A.student, 'select 1 from public.question_answer_keys')).toHaveLength(0);
    });
    it('cannot read exams directly or create/modify them', async () => {
      expect(await asUser(A.student, 'select 1 from public.exams')).toHaveLength(0);
      await expectDenied(
        A.student,
        `insert into exams (organization_id, name, exam_code, duration_minutes) values ($1,'x','SX',10)`,
        [A.orgId],
      );
      expect(
        await asUser(A.student, `update public.exams set name='x' where id=$1 returning id`, [
          A.examId,
        ]),
      ).toHaveLength(0);
    });
    it('cannot write attempts, answers or results directly (privileges revoked)', async () => {
      await expectDenied(
        A.student,
        `insert into results (organization_id, attempt_id, student_id, exam_id, score, maximum_score, percentage, correct_count, wrong_count, unanswered_count, duration_seconds, status) values ($1,gen_random_uuid(),$2,$3,100,100,100,1,0,0,1,'Passed')`,
        [A.orgId, A.studentId, A.examId],
      );
      await expectDenied(
        A.student,
        `insert into exam_attempts (organization_id, exam_id, student_id, attempt_no, deadline_at, question_order) values ($1,$2,$3,9,now(),'{}')`,
        [A.orgId, A.examId, A.studentId],
      );
    });
    it('cannot see other students, teachers or the member list', async () => {
      const students = await asUser(A.student, 'select user_id from public.students');
      expect(students).toHaveLength(1);
      expect(students[0]!.user_id).toBe(A.student);
      expect(await asUser(A.student, 'select 1 from public.teachers')).toHaveLength(0);
      const members = await asUser(A.student, 'select user_id from public.organization_members');
      expect(members.map((m) => m.user_id)).toEqual([A.student]);
    });
    it('cannot assign themselves a role', async () => {
      const role = (await pool.query(`select id from roles where code='TEACHER'`)).rows[0].id;
      await expectDenied(
        A.student,
        `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3)`,
        [A.orgId, A.student, role],
      );
    });
  });

  describe('roles and escalation', () => {
    it('admin cannot grant OWNER or ADMIN; owner can grant ADMIN but never OWNER', async () => {
      const owner = (await pool.query(`select id from roles where code='ORGANIZATION_OWNER'`))
        .rows[0].id;
      const adminRole = (await pool.query(`select id from roles where code='ORGANIZATION_ADMIN'`))
        .rows[0].id;
      await expectDenied(
        A.admin,
        `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3)`,
        [A.orgId, A.teacher1, owner],
      );
      await expectDenied(
        A.admin,
        `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3)`,
        [A.orgId, A.teacher1, adminRole],
      );
      await expectDenied(
        A.owner,
        `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3)`,
        [A.orgId, A.teacher1, owner],
      );
      const ok = await asUser(
        A.owner,
        `insert into user_roles (organization_id, user_id, role_id) values ($1,$2,$3) returning id`,
        [A.orgId, A.teacher2, adminRole],
      );
      expect(ok).toHaveLength(1);
    });
    it('nobody can remove the owner role through the API', async () => {
      const r = await asUser(
        A.owner,
        `delete from public.user_roles ur using public.roles r where r.id = ur.role_id and r.code='ORGANIZATION_OWNER' and ur.organization_id=$1 returning ur.id`,
        [A.orgId],
      );
      expect(r).toHaveLength(0);
    });
    it('admin cannot suspend the owner', async () => {
      const r = await asUser(
        A.admin,
        `update public.organization_members set status='suspended' where organization_id=$1 and user_id=$2 returning id`,
        [A.orgId, A.owner],
      );
      expect(r).toHaveLength(0);
    });
    it('a user cannot make themselves platform admin or change org status/code', async () => {
      await expectDenied(
        A.owner,
        `update public.profiles set is_platform_super_admin = true where id = $1`,
        [A.owner],
      );
      await expectDenied(
        A.owner,
        `update public.organizations set status = 'active', org_code = 'ORG-999999' where id = $1`,
        [A.orgId],
      );
      const ok = await asUser(
        A.owner,
        `update public.organizations set name='A College Renamed' where id=$1 returning id`,
        [A.orgId],
      );
      expect(ok).toHaveLength(1);
    });
    it('admin cannot edit organization profile (no organization.update permission)', async () => {
      expect(
        await asUser(A.admin, `update public.organizations set name='x' where id=$1 returning id`, [
          A.orgId,
        ]),
      ).toHaveLength(0);
    });
  });

  describe('platform super admin is not an organization owner', () => {
    it('can read organizations and audit logs but not questions, students or results', async () => {
      const p = await createUser('platform');
      await pool.query(
        `insert into profiles (id, email, full_name, is_platform_super_admin) values ($1,$2,'Platform',true)`,
        [p.id, p.email],
      );
      expect(
        (await asUser(p.id, 'select id from public.organizations')).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await asUser(p.id, 'select 1 from public.questions')).toHaveLength(0);
      expect(await asUser(p.id, 'select 1 from public.students')).toHaveLength(0);
      expect(await asUser(p.id, 'select 1 from public.results')).toHaveLength(0);
      expect(await asUser(p.id, `update public.subjects set name='x' returning id`)).toHaveLength(
        0,
      );
    });
  });

  describe('anonymous and audit', () => {
    it('anon role has no access to any table', async () => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role anon');
        await expect(c.query('select 1 from public.organizations')).rejects.toThrow(
          /permission denied/,
        );
        await c.query('rollback');
      } finally {
        c.release();
      }
    });
    it('audit log is append-only for users', async () => {
      await pool.query(
        `insert into audit_logs (organization_id, user_id, action, resource) values ($1,$2,'TEST','x')`,
        [A.orgId, A.owner],
      );
      await expectDenied(A.owner, `update public.audit_logs set action='X'`);
      await expectDenied(A.owner, `delete from public.audit_logs`);
      expect(
        (
          await asUser(A.owner, 'select 1 from public.audit_logs where organization_id=$1', [
            A.orgId,
          ])
        ).length,
      ).toBeGreaterThan(0);
      expect(await asUser(A.teacher1, 'select 1 from public.audit_logs')).toHaveLength(0);
    });
  });
});
