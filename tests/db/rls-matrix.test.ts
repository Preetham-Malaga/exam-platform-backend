// Phase 7: the isolation guarantee, generated for EVERY tenant table (new tables are covered automatically).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATABASE_TEST_URL,
  asUser,
  createTenant,
  createUser,
  pool,
  withUser,
  type Tenant,
} from './helpers.js';

const DENIED = /row-level security|permission denied/i;

describe.skipIf(!DATABASE_TEST_URL)(
  'tenant isolation matrix: every tenant table x every role (real PostgreSQL)',
  () => {
    let A: Tenant;
    let B: Tenant;
    let tables: string[] = [];

    beforeAll(async () => {
      A = await createTenant('matrixA');
      B = await createTenant('matrixB');
      tables = (
        await pool.query(
          `select table_name as n from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' order by 1`,
        )
      ).rows.map((r) => r.n as string);
    });
    afterAll(() => pool.end());

    const aUsers = () => ({
      owner: A.owner,
      admin: A.admin,
      teacher: A.teacher1,
      student: A.student,
    });

    /** Runs a statement as a user and reports "refused" (error) or the number of rows it touched. */
    const attempt = async (user: string, sql: string, params: unknown[]) => {
      try {
        const r = await withUser(pool, user, (db) => db.query(sql, params));
        return { refused: false as const, rows: r.rowCount ?? r.rows.length };
      } catch (e) {
        return { refused: true as const, message: (e as Error).message };
      }
    };

    it('covers the whole schema (guards against the matrix silently becoming empty)', () => {
      expect(tables.length).toBeGreaterThanOrEqual(25);
      for (const t of [
        'students',
        'questions',
        'question_answer_keys',
        'exams',
        'results',
        'audit_logs',
        'files',
      ])
        expect(tables, t).toContain(t);
    });

    it('SELECT: no role of College A can read a single row of College B in any tenant table', async () => {
      const leaks: string[] = [];
      for (const [role, user] of Object.entries(aUsers())) {
        for (const t of tables) {
          const r = await attempt(user, `select 1 from public.${t} where organization_id = $1`, [
            B.orgId,
          ]);
          if (!r.refused && r.rows > 0) leaks.push(`${role} read ${r.rows} row(s) of ${t}`);
        }
      }
      expect(leaks).toEqual([]);
    });

    it('UPDATE: no role of College A can change a single row of College B', async () => {
      const touched: string[] = [];
      for (const [role, user] of Object.entries(aUsers())) {
        for (const t of tables) {
          const r = await attempt(
            user,
            `update public.${t} set organization_id = organization_id where organization_id = $1`,
            [B.orgId],
          );
          if (!r.refused && r.rows > 0) touched.push(`${role} updated ${r.rows} row(s) of ${t}`);
        }
      }
      expect(touched).toEqual([]);
    });

    it('DELETE: no role of College A can delete a single row of College B', async () => {
      const touched: string[] = [];
      for (const [role, user] of Object.entries(aUsers())) {
        for (const t of tables) {
          const r = await attempt(user, `delete from public.${t} where organization_id = $1`, [
            B.orgId,
          ]);
          if (!r.refused && r.rows > 0) touched.push(`${role} deleted ${r.rows} row(s) of ${t}`);
        }
      }
      expect(touched).toEqual([]);
      // and College B is still complete
      for (const t of ['students', 'questions', 'exams', 'organization_members']) {
        expect(
          (
            await pool.query(`select count(*)::int c from public.${t} where organization_id = $1`, [
              B.orgId,
            ])
          ).rows[0].c,
          t,
        ).toBeGreaterThan(0);
      }
    });

    it('INSERT: no role of College A can create rows inside College B (refused by RLS / privileges, not by a typo)', async () => {
      const b = B.orgId;
      // Real ids of College B (read as the system): an INSERT ... SELECT run as College A would see no B rows,
      // insert nothing and look like a success, so every template names B's parents explicitly.
      const bLevel: string = (
        await pool.query('select id from academic_levels where organization_id = $1 limit 1', [b])
      ).rows[0].id;
      const templates: Record<string, [string, unknown[]]> = {
        academic_levels: [
          `insert into academic_levels (organization_id, code, name, position) values ($1,'X','X',9)`,
          [b],
        ],
        academic_units: [
          `insert into academic_units (organization_id, level_id, code, name) values ($1,$2,'X','X')`,
          [b, bLevel],
        ],
        courses: [`insert into courses (organization_id, code, name) values ($1,'X','X')`, [b]],
        subjects: [`insert into subjects (organization_id, code, name) values ($1,'X','X')`, [b]],
        topics: [
          `insert into topics (organization_id, subject_id, name) values ($1,$2,'X')`,
          [b, B.subject1],
        ],
        students: [
          `insert into students (organization_id, roll_number, full_name) values ($1,'X','X')`,
          [b],
        ],
        teachers: [
          `insert into teachers (organization_id, employee_code, full_name) values ($1,'X','X')`,
          [b],
        ],
        questions: [
          `insert into questions (organization_id, subject_id, question_type, question_text) values ($1,$2,'multiple_choice','X')`,
          [b, B.subject1],
        ],
        question_options: [
          `insert into question_options (organization_id, question_id, option_text, position) values ($1,$2,'X',9)`,
          [b, B.q1],
        ],
        question_answer_keys: [
          `insert into question_answer_keys (organization_id, question_id, correct_option_id) values ($1,$2,$3)`,
          [b, B.q2, B.q1Options[0]],
        ],
        exams: [
          `insert into exams (organization_id, name, exam_code, duration_minutes) values ($1,'X','XX',5)`,
          [b],
        ],
        exam_settings: [
          `insert into exam_settings (organization_id, exam_id) values ($1,$2)`,
          [b, B.examId],
        ],
        exam_questions: [
          `insert into exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,9)`,
          [b, B.examId, B.q1],
        ],
        exam_assignments: [
          `insert into exam_assignments (organization_id, exam_id, target_type, target_id) values ($1,$2,'organization',$1)`,
          [b, B.examId],
        ],
        exam_attempts: [
          `insert into exam_attempts (organization_id, exam_id, student_id, attempt_no, deadline_at, question_order) values ($1,$2,$3,9,now(),'{}')`,
          [b, B.examId, B.studentId],
        ],
        results: [
          `insert into results (organization_id, attempt_id, student_id, exam_id, score, maximum_score, percentage, correct_count, wrong_count, unanswered_count, duration_seconds, status) values ($1,gen_random_uuid(),$2,$3,1,1,100,1,0,0,1,'Passed')`,
          [b, B.studentId, B.examId],
        ],
        leaderboards: [
          `insert into leaderboards (organization_id, exam_id, student_id, best_result_id, best_score, best_percentage, best_duration_seconds, attempts_count) values ($1,$2,$3,gen_random_uuid(),1,1,1,1)`,
          [b, B.examId, B.studentId],
        ],
        files: [
          `insert into files (organization_id, path, kind) values ($1::uuid, 'organizations/' || $1::text || '/x.png', 'logo')`,
          [b],
        ],
        notifications: [
          `insert into notifications (organization_id, user_id, type, title) values ($1,$2,'x','x')`,
          [b, B.owner],
        ],
        audit_logs: [
          `insert into audit_logs (organization_id, action, resource) values ($1,'FAKE','x')`,
          [b],
        ],
        organization_members: [
          `insert into organization_members (organization_id, user_id) values ($1,$2)`,
          [b, A.owner],
        ],
        user_roles: [
          `insert into user_roles (organization_id, user_id, role_id) select $1, $2, id from roles where code = 'TEACHER'`,
          [b, B.student],
        ],
        user_scopes: [
          `insert into user_scopes (organization_id, user_id, scope_type, scope_id) values ($1,$2,'subject',$3)`,
          [b, B.teacher1, B.subject2],
        ],
        subscriptions: [
          `insert into subscriptions (organization_id, plan_id, status) select $1, id, 'active' from plans limit 1`,
          [b],
        ],
        organization_settings: [
          `insert into organization_settings (organization_id) values ($1)`,
          [b],
        ],
      };
      const missing = tables.filter(
        (t) => !templates[t] && !['attempt_answers', 'roles'].includes(t),
      );
      expect(missing, 'add an INSERT template for every new tenant table').toEqual([]);
      templates.attempt_answers = [
        `insert into attempt_answers (organization_id, attempt_id, question_id) values ($1,gen_random_uuid(),$2)`,
        [b, B.q1],
      ];
      templates.roles = [
        `insert into roles (organization_id, code, name) values ($1,'HACK','Hack')`,
        [b],
      ];

      // Tables whose BEFORE trigger refuses first: the trigger runs with the caller's rights, cannot see
      // College B's rows and rejects the target (038 validate_user_scope). Still a refusal, for a known reason.
      const refusedEarlier: Record<string, RegExp> = { user_scopes: /INVALID_SCOPE_TARGET/ };
      const failures: string[] = [];
      for (const [role, user] of Object.entries(aUsers())) {
        for (const [t, [sql, params]] of Object.entries(templates)) {
          const r = await attempt(user, sql, params);
          if (!r.refused) failures.push(`${role} inserted ${r.rows} row(s) into ${t} of College B`);
          else if (!DENIED.test(r.message) && !refusedEarlier[t]?.test(r.message))
            failures.push(`${role} -> ${t}: refused for the WRONG reason: ${r.message}`);
        }
      }
      expect(failures).toEqual([]);
      expect(
        Number(
          (await pool.query(`select count(*)::int c from audit_logs where action = 'FAKE'`)).rows[0]
            .c,
        ),
      ).toBe(0);
    });

    it('a signed-in user with no organization sees no tenant data at all', async () => {
      const loner = await createUser('loner');
      const seen: string[] = [];
      for (const t of tables) {
        const r = await attempt(loner.id, `select 1 from public.${t}`, []);
        if (!r.refused && r.rows > 0 && !['roles'].includes(t)) seen.push(`${t}: ${r.rows}`);
      }
      expect(seen).toEqual([]); // roles: system roles are readable catalogue data, handled below
      const sys = await asUser(
        loner.id,
        `select code from public.roles where organization_id is not null`,
      );
      expect(sys).toHaveLength(0);
    });

    it('platform staff can read organizations, subscriptions, audit logs and profiles, and NOTHING that belongs to an organization', async () => {
      const p = await createUser('platform');
      await pool.query(
        `insert into profiles (id, email, full_name, is_platform_super_admin) values ($1,$2,'P',true)`,
        [p.id, p.email],
      );
      await pool.query(
        `insert into audit_logs (organization_id, action, resource) values ($1, 'TEST', 'x')`,
        [A.orgId],
      );
      const allowed = new Set(['organizations', 'subscriptions', 'audit_logs']);
      const seen: string[] = [];
      for (const t of tables) {
        const r = await attempt(p.id, `select 1 from public.${t}`, []);
        if (!r.refused && r.rows > 0 && !allowed.has(t) && t !== 'roles')
          seen.push(`${t}: ${r.rows}`);
      }
      expect(seen).toEqual([]);
      for (const t of allowed)
        expect((await asUser(p.id, `select 1 from public.${t}`)).length, t).toBeGreaterThan(0);
      expect((await asUser(p.id, 'select 1 from public.profiles')).length).toBeGreaterThan(5);
      // Either RLS hides every row (0 updated) or the privilege is revoked outright (results: 036).
      for (const t of ['students', 'questions', 'results', 'question_answer_keys']) {
        const r = await attempt(
          p.id,
          `update public.${t} set organization_id = organization_id`,
          [],
        );
        if (r.refused) expect(r.message, t).toMatch(DENIED);
        else expect(r.rows, t).toBe(0);
      }
    });

    it('each college sees exactly its own rows in the core tables', async () => {
      for (const [T, label] of [
        [A, 'A'],
        [B, 'B'],
      ] as const) {
        for (const t of ['students', 'subjects', 'questions', 'exams', 'organization_members']) {
          const rows = await asUser<{ organization_id: string }>(
            T.owner,
            `select organization_id from public.${t}`,
          );
          expect(rows.length, `${label} ${t}`).toBeGreaterThan(0);
          expect(new Set(rows.map((r) => r.organization_id)), `${label} ${t}`).toEqual(
            new Set([T.orgId]),
          );
        }
      }
    });
  },
);
