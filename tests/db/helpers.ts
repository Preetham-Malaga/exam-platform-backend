// Test helpers: build two isolated colleges with every role, using the real migrations on a real Postgres.
import pg from 'pg';
import { withSystem, withUser } from '../../src/db/context.js';

export const DATABASE_TEST_URL = process.env.DATABASE_TEST_URL;
export const pool = DATABASE_TEST_URL
  ? new pg.Pool({ connectionString: DATABASE_TEST_URL, max: 5 })
  : (undefined as unknown as pg.Pool);
export { withSystem, withUser };

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}.${uniq()}@test.local`;
  const r = await pool.query(
    'insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id',
    [email],
  );
  return { id: r.rows[0].id, email };
}

export interface Tenant {
  orgId: string;
  owner: string;
  admin: string;
  teacher1: string; // scoped to subject1
  teacher2: string; // scoped to subject2
  student: string; // user id of student 1
  student2: string; // user id of student 2
  studentId: string;
  student2Id: string;
  unitId: string;
  courseId: string;
  subject1: string;
  subject2: string;
  q1: string; // published question in subject1 (key = option index 0)
  q2: string; // published question in subject2
  q1Options: string[];
  examId: string; // published exam with q1+q2, assigned to the organization
}

export async function createTenant(name: string): Promise<Tenant> {
  const owner = await createUser(`${name}.owner`);
  const orgId: string = (
    await pool.query('select app.register_organization($1, $2, $3, $4, $5) as id', [
      owner.id,
      owner.email,
      `${name} Owner`,
      `${name} College`,
      'engineering',
    ])
  ).rows[0].id;
  await pool.query('select app.activate_organization($1)', [orgId]);

  const mk = async (label: string, role: string) => {
    const u = await createUser(`${name}.${label}`);
    await pool.query('select app.add_member($1, $2, $3, $4, $5, $6)', [
      orgId,
      u.id,
      u.email,
      label,
      role,
      owner.id,
    ]);
    return u.id as string;
  };
  const admin = await mk('admin', 'ORGANIZATION_ADMIN');
  const teacher1 = await mk('teacher1', 'TEACHER');
  const teacher2 = await mk('teacher2', 'TEACHER');
  const student = await mk('student1', 'STUDENT');
  const student2 = await mk('student2', 'STUDENT');

  const level = (
    await pool.query(
      'select id from academic_levels where organization_id=$1 order by position limit 1',
      [orgId],
    )
  ).rows[0].id;
  const unitId = (
    await pool.query(
      `insert into academic_units (organization_id, level_id, code, name) values ($1,$2,'U1','Unit 1') returning id`,
      [orgId, level],
    )
  ).rows[0].id;
  const courseId = (
    await pool.query(
      `insert into courses (organization_id, code, name, academic_unit_id) values ($1,'C1','Course 1',$2) returning id`,
      [orgId, unitId],
    )
  ).rows[0].id;
  const subject1 = (
    await pool.query(
      `insert into subjects (organization_id, course_id, academic_unit_id, code, name) values ($1,$2,$3,'S1','Subject 1') returning id`,
      [orgId, courseId, unitId],
    )
  ).rows[0].id;
  const subject2 = (
    await pool.query(
      `insert into subjects (organization_id, course_id, academic_unit_id, code, name) values ($1,$2,$3,'S2','Subject 2') returning id`,
      [orgId, courseId, unitId],
    )
  ).rows[0].id;
  await pool.query(
    `insert into user_scopes (organization_id, user_id, scope_type, scope_id) values ($1,$2,'subject',$3),($1,$4,'subject',$5)`,
    [orgId, teacher1, subject1, teacher2, subject2],
  );

  const studentId = (
    await pool.query(
      `insert into students (organization_id, user_id, roll_number, full_name, academic_unit_id) values ($1,$2,'R1','Student One',$3) returning id`,
      [orgId, student, unitId],
    )
  ).rows[0].id;
  const student2Id = (
    await pool.query(
      `insert into students (organization_id, user_id, roll_number, full_name, academic_unit_id) values ($1,$2,'R2','Student Two',$3) returning id`,
      [orgId, student2, unitId],
    )
  ).rows[0].id;

  const makeQuestion = async (subject: string, text: string) => {
    const q = (
      await pool.query(
        `insert into questions (organization_id, subject_id, question_type, question_text, marks, negative_marks, created_by) values ($1,$2,'multiple_choice',$3,2,1,$4) returning id`,
        [orgId, subject, text, owner.id],
      )
    ).rows[0].id;
    const opts: string[] = [];
    for (let i = 1; i <= 4; i++) {
      opts.push(
        (
          await pool.query(
            `insert into question_options (organization_id, question_id, option_text, position) values ($1,$2,$3,$4) returning id`,
            [orgId, q, `Option ${i}`, i],
          )
        ).rows[0].id,
      );
    }
    await pool.query(
      `insert into question_answer_keys (organization_id, question_id, correct_option_id) values ($1,$2,$3)`,
      [orgId, q, opts[0]],
    );
    await pool.query(`update questions set status='published' where id=$1`, [q]);
    return { q, opts };
  };
  const a = await makeQuestion(subject1, 'What is 1+1?');
  const b = await makeQuestion(subject2, 'What is 2+2?');

  const examId = (
    await pool.query(
      `insert into exams (organization_id, name, exam_code, duration_minutes, passing_percentage, created_by) values ($1,'Midterm','MID1',30,50,$2) returning id`,
      [orgId, owner.id],
    )
  ).rows[0].id;
  await pool.query(
    `insert into exam_settings (organization_id, exam_id, max_attempts, show_results, show_answers, leaderboard_enabled) values ($1,$2,2,true,true,true)`,
    [orgId, examId],
  );
  await pool.query(
    `insert into exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,1),($1,$2,$4,2)`,
    [orgId, examId, a.q, b.q],
  );
  await pool.query(
    `insert into exam_assignments (organization_id, exam_id, target_type, target_id) values ($1,$2,'organization',$1)`,
    [orgId, examId],
  );
  await pool.query(`update exams set status='published' where id=$1`, [examId]);

  return {
    orgId,
    owner: owner.id,
    admin,
    teacher1,
    teacher2,
    student,
    student2,
    studentId,
    student2Id,
    unitId,
    courseId,
    subject1,
    subject2,
    q1: a.q,
    q2: b.q,
    q1Options: a.opts,
    examId,
  };
}

/** Run a query as a user and return rows (RLS applies). */
export async function asUser<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withUser(pool, userId, async (db) => (await db.query(sql, params)).rows as T[]);
}

/** Expect a user-context statement to be rejected by Postgres (RLS / privileges / constraints). */
export async function expectDenied(
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await withUser(pool, userId, (db) => db.query(sql, params));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`Expected "${sql}" to be denied for ${userId}, but it succeeded`);
}
