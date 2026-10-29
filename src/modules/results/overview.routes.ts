// PURPOSE: GET /organizations/current/overview - everything the owner dashboard (prototype vDashOwner) shows, in one call:
//          headline tiles, the five-step flow (courses → questions → exams → students → results), results per day,
//          "needs your attention", the exams table and top students. Filters: date range, batch, course, exam.
// WHY: The database is far from the users; one request (one transaction, one connection) keeps the dashboard fast.
//      Runs as the caller, so RLS scopes every number (a teacher sees only their exams and students).
//      "Batch" is the student's group (academic unit) until the Batches screen (step 7) replaces it.
// DEPENDS ON: results (028), exams (022), exam_assignments (025), app.exam_assigned_to_student (037), settings timezone (003).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { ok } from '../../utils/response.js';
import { API, type Deps } from '../deps.js';

const filterSchema = z.object({
  range: z.enum(['today', '7', '30', 'month']).default('30'),
  batch: z.uuid().optional(),
  course: z.uuid().optional(),
  exam: z.uuid().optional(),
});
export type OverviewFilter = z.infer<typeof filterSchema>;

/** First day of the range, as SQL on the organization's local date ($tz). */
const RANGE_START: Record<OverviewFilter['range'], string> = {
  today: 'local_today',
  '7': 'local_today - 6',
  '30': 'local_today - 29',
  month: "date_trunc('month', local_today)::date",
};

async function overview(db: Db, org: string, f: OverviewFilter) {
  const one = async (sql: string, params: unknown[]) =>
    (await db.query(sql, params)).rows[0] as Record<string, unknown>;
  const many = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows;

  const tz =
    ((await one(`select timezone from public.organization_settings where organization_id = $1`, [org]))
      ?.timezone as string | undefined) ?? 'Asia/Kolkata';
  // The zone name is written into SQL below, so only plain IANA names are accepted.
  const zone = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) ? tz : 'Asia/Kolkata';
  const today = `(now() at time zone '${zone}')::date`;
  const start = RANGE_START[f.range].replace(/local_today/g, today);

  // Shared filters: $1 org, $2 batch (unit) or null, $3 course or null, $4 exam or null.
  const p = [org, f.batch ?? null, f.course ?? null, f.exam ?? null];
  const studentF = `s.organization_id = $1 and s.deleted_at is null and s.status = 'active'
    and ($2::uuid is null or s.academic_unit_id = $2)`;
  const examF = `e.organization_id = $1 and e.deleted_at is null
    and ($3::uuid is null or e.course_id = $3) and ($4::uuid is null or e.id = $4)`;
  const examState = `case when e.status = 'draft' then 'draft'
    when e.status = 'published' and e.end_at is not null and e.end_at < now() then 'closed'
    when e.status = 'published' then 'published' else 'closed' end`;

  const people = await one(
    `select
       (select count(*)::int from public.students s where ${studentF}) as students,
       (select count(distinct s.academic_unit_id)::int from public.students s where ${studentF}) as batches,
       (select count(*)::int from public.students s where ${studentF} and s.user_id is null) as "notInvited",
       (select count(*)::int from public.students s where ${studentF} and s.academic_unit_id is null) as "noBatch",
       (select count(*)::int from public.teachers t where t.organization_id = $1 and t.deleted_at is null and t.status = 'active') as teachers`,
    p.slice(0, 2),
  );
  const catalog = await one(
    `select
       (select count(*)::int from public.courses c where c.organization_id = $1 and c.deleted_at is null) as courses,
       (select count(*)::int from public.subjects sb where sb.organization_id = $1 and sb.deleted_at is null) as subjects,
       (select count(*)::int from public.topics t where t.organization_id = $1 and t.deleted_at is null) as topics,
       (select count(*)::int from public.subjects sb where sb.organization_id = $1 and sb.deleted_at is null
          and not exists (select 1 from public.topics t where t.subject_id = sb.id and t.deleted_at is null)) as "subjectsWithoutTopics"`,
    [org],
  );
  const questions = await one(
    `select count(*)::int as total,
       count(*) filter (where q.status = 'published')::int as published,
       count(*) filter (where q.status = 'draft')::int as draft,
       count(*) filter (where q.difficulty = 'easy')::int as easy,
       count(*) filter (where q.difficulty = 'medium')::int as medium,
       count(*) filter (where q.difficulty = 'hard')::int as hard
     from public.questions q
     left join public.subjects sb on sb.organization_id = q.organization_id and sb.id = q.subject_id
     where q.organization_id = $1 and q.deleted_at is null and ($2::uuid is null or sb.course_id = $2)`,
    [org, f.course ?? null],
  );
  const exams = await many(
    `select e.id, e.name, e.exam_code as code, ${examState} as state, e.start_at as "startAt", e.end_at as "endAt",
       e.duration_minutes as "durationMinutes", c.name as "courseName",
       (select count(*)::int from public.exam_questions eq where eq.exam_id = e.id) as "questionCount",
       (select count(*)::int from public.exam_assignments ea where ea.exam_id = e.id) as "assignmentCount",
       (select count(*)::int from public.students s where ${studentF}
          and app.exam_assigned_to_student($1, e.id, s.id)) as students,
       (select count(*)::int from public.results r join public.students s on s.id = r.student_id
          where r.exam_id = e.id and ${studentF}) as attempts,
       (select round(avg(r.percentage), 1)::float from public.results r join public.students s on s.id = r.student_id
          where r.exam_id = e.id and ${studentF}) as "averagePercentage"
     from public.exams e
     left join public.courses c on c.organization_id = e.organization_id and c.id = e.course_id
     where ${examF}
     order by (e.status = 'published') desc, coalesce(e.start_at, e.created_at) desc
     limit 12`,
    p,
  );
  const examCounts = await one(
    `select count(*) filter (where st = 'published')::int as open, count(*) filter (where st = 'draft')::int as draft,
            count(*) filter (where st = 'closed')::int as closed
     from (select ${examState} as st from public.exams e
           where ${examF.replace('$3', '$2').replace('$3', '$2').replace('$4', '$3').replace('$4', '$3')}) x`,
    [org, f.course ?? null, f.exam ?? null],
  );
  // Results in the date range, for the chosen batch / course / exam.
  const resultsF = `r.organization_id = $1 and ${studentF.replace('s.organization_id = $1 and ', '')}
    and ($3::uuid is null or e.course_id = $3) and ($4::uuid is null or e.id = $4)`;
  const resultsFrom = `public.results r join public.students s on s.id = r.student_id
    join public.exams e on e.id = r.exam_id`;
  const results = await one(
    `select count(*)::int as results,
       round(avg(r.percentage), 1)::float as "averagePercentage",
       count(*) filter (where r.status = 'Passed')::int as passed,
       (select count(*)::int from ${resultsFrom} where ${resultsF}) as "allAttempts"
     from ${resultsFrom}
     where ${resultsF} and (r.evaluated_at at time zone '${zone}')::date >= ${start}`,
    p,
  );
  const perDay = await many(
    `select to_char(d, 'YYYY-MM-DD') as day, count(r.id)::int as results
     from generate_series(${start}, ${today}, interval '1 day') d
     left join (select r.id, (r.evaluated_at at time zone '${zone}')::date as day
                from ${resultsFrom} where ${resultsF}) r on r.day = d::date
     group by d order by d`,
    p,
  );
  const recent = await many(
    `select r.id, s.full_name as "studentName", s.roll_number as "rollNumber", e.name as "examName",
       r.percentage::float as percentage, r.status, r.evaluated_at as "evaluatedAt"
     from ${resultsFrom} where ${resultsF}
     order by r.evaluated_at desc limit 5`,
    p,
  );
  const top = await many(
    `select r.id, s.full_name as "studentName", s.roll_number as "rollNumber", e.name as "examName",
       r.percentage::float as percentage
     from ${resultsFrom} where ${resultsF} and (r.evaluated_at at time zone '${zone}')::date >= ${start}
     order by r.percentage desc, r.evaluated_at asc limit 3`,
    p,
  );
  const teachers = await many(
    `select t.id, t.full_name as name, t.email, (t.user_id is not null) as "hasLogin"
     from public.teachers t where t.organization_id = $1 and t.deleted_at is null and t.status = 'active'
     order by t.full_name limit 5`,
    [org],
  );

  const n = (v: unknown) => Number(v ?? 0);
  const resCount = n(results.results);
  return {
    filter: f,
    timezone: zone,
    headline: {
      students: n(people.students),
      batches: n(people.batches),
      examsOpen: n(examCounts.open),
      examsDraft: n(examCounts.draft),
      results: resCount,
      attempts: n(results.allAttempts),
      averagePercentage: results.averagePercentage ?? null,
      passed: n(results.passed),
      passRate: resCount ? Math.round((100 * n(results.passed)) / resCount) : null,
      // Live classes arrive with the Learning screens (step 8).
      liveToday: null,
    },
    flow: {
      courses: { ...catalog },
      questions: { ...questions },
      exams: { ...examCounts, attempts: n(results.allAttempts) },
      students: {
        students: n(people.students),
        batches: n(people.batches),
        teachers: n(people.teachers),
        notInvited: n(people.notInvited),
        noBatch: n(people.noBatch),
      },
      results: {
        results: resCount,
        averagePercentage: results.averagePercentage ?? null,
        passRate: resCount ? Math.round((100 * n(results.passed)) / resCount) : null,
        belowPass: resCount - n(results.passed),
      },
    },
    perDay,
    exams,
    recentResults: recent,
    topStudents: top,
    teachers,
  };
}

export function registerOverviewRoutes(app: FastifyInstance, d: Deps): void {
  app.get(
    `${API}/organizations/current/overview`,
    { preHandler: [d.authenticate, requirePermission('report.read')] },
    async (req) => {
      const f = filterSchema.parse(req.query);
      const org = req.ctx.organization!.id;
      return ok(await withUser(d.pool, req.ctx.userId, (db) => overview(db, org, f)), req.id);
    },
  );
}
