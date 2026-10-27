// PURPOSE: Insights for staff: results (list + per-attempt detail), leaderboards, reports, and the dashboard summary.
// WHY: Guide Part 18 steps 16-17. Every query runs in the caller's session, so RLS decides what is counted:
//      owners/admins see the whole organization, teachers only the exams they created (app.exam_accessible).
// DEPENDS ON: results/exam_attempts/attempt_answers/leaderboards (026-029), SQL app.leaderboard (040).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { AppError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { idParams, withTotal } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const RESULT_SORT: Record<string, string> = {
  evaluatedAt: 'r.evaluated_at',
  percentage: 'r.percentage',
  studentName: 's.full_name',
  examName: 'e.name',
};
const REPORTS = ['exam-performance', 'question-performance', 'student-performance'] as const;

export function registerInsightRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  // ---------- results ----------
  app.get(
    `${API}/results`,
    { preHandler: [d.authenticate, requirePermission('result.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({
          examId: z.uuid().optional(),
          studentId: z.uuid().optional(),
          status: z.enum(['Passed', 'Failed', 'Pending']).optional(),
        })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['r.organization_id = $1'];
      if (f.examId) where.push(`r.exam_id = $${params.push(f.examId)}`);
      if (f.studentId) where.push(`r.student_id = $${params.push(f.studentId)}`);
      if (f.status) where.push(`r.status = $${params.push(f.status)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(`(s.full_name ilike $${p} or s.roll_number ilike $${p})`);
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select r.id, r.attempt_id as "attemptId", r.exam_id as "examId", e.name as "examName",
                    e.exam_code as "examCode", r.student_id as "studentId", s.full_name as "studentName",
                    s.roll_number as "rollNumber", u.name as "academicUnitName",
                    r.score::float as score, r.maximum_score::float as "maximumScore",
                    r.percentage::float as percentage, r.status, r.correct_count as "correctCount",
                    r.wrong_count as "wrongCount", r.unanswered_count as "unansweredCount",
                    r.duration_seconds as "durationSeconds", r.evaluated_at as "evaluatedAt",
                    a.attempt_no as "attemptNo", a.auto_submitted as "autoSubmitted",
                    count(*) over() as "__total"
             from public.results r
             join public.exams e on e.id = r.exam_id
             join public.students s on s.id = r.student_id
             join public.exam_attempts a on a.id = r.attempt_id
             left join public.academic_units u on u.id = s.academic_unit_id
             where ${where.join(' and ')}
             order by ${RESULT_SORT[q.sort ?? 'evaluatedAt'] ?? RESULT_SORT.evaluatedAt} ${q.order === 'asc' ? 'asc' : 'desc'}, r.id
             limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows,
      );
      const { items, total } = withTotal(rows);
      return ok(paginate(items, total, q), req.id);
    },
  );

  // Staff view of one attempt, question by question (always with the correct answer: staff are not students).
  app.get(
    `${API}/results/:id`,
    { preHandler: [d.authenticate, requirePermission('result.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = (
          await db.query(
            `select r.id, r.attempt_id as "attemptId", r.exam_id as "examId", e.name as "examName",
                  s.full_name as "studentName", s.roll_number as "rollNumber",
                  r.score::float as score, r.maximum_score::float as "maximumScore", r.percentage::float as percentage,
                  r.status, r.correct_count as "correctCount", r.wrong_count as "wrongCount",
                  r.unanswered_count as "unansweredCount", r.duration_seconds as "durationSeconds",
                  r.evaluated_at as "evaluatedAt", a.started_at as "startedAt", a.submitted_at as "submittedAt",
                  a.auto_submitted as "autoSubmitted", a.attempt_no as "attemptNo", a.question_order as "questionOrder"
           from public.results r
           join public.exams e on e.id = r.exam_id
           join public.students s on s.id = r.student_id
           join public.exam_attempts a on a.id = r.attempt_id
           where r.organization_id = $1 and r.id = $2`,
            [org(req), id],
          )
        ).rows[0] as Record<string, unknown> | undefined;
        if (!r) throw notFound('Result');
        const answers = (
          await db.query(
            `select q.id as "questionId", u.ord::int as position, q.question_text as "questionText",
                  eq.marks::float as marks, aa.selected_option_id as "selectedOptionId",
                  k.correct_option_id as "correctOptionId", aa.is_correct as "isCorrect",
                  coalesce(aa.marks_awarded, 0)::float as "marksAwarded",
                  (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text) order by o.position), '[]')
                     from public.question_options o where o.question_id = q.id) as options
           from unnest($3::uuid[]) with ordinality as u(qid, ord)
           join public.questions q on q.id = u.qid
           join public.exam_questions eq on eq.exam_id = $2 and eq.question_id = q.id
           left join public.question_answer_keys k on k.question_id = q.id
           left join public.attempt_answers aa on aa.attempt_id = $4 and aa.question_id = q.id
           where q.organization_id = $1
           order by u.ord`,
            [org(req), r.examId, r.questionOrder, r.attemptId],
          )
        ).rows;
        delete r.questionOrder; // internal: the order is already applied to the answers
        return { ...r, answers };
      });
      return ok(data, req.id);
    },
  );

  // ---------- leaderboards ----------
  app.get(
    `${API}/leaderboards`,
    { preHandler: [d.authenticate, requirePermission('leaderboard.read')] },
    async (req) => {
      const f = z
        .object({
          scope: z
            .enum(['exam', 'organization', 'academic_unit', 'subject'])
            .default('organization'),
          scopeId: z.uuid().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      if (f.scope !== 'organization' && !f.scopeId)
        throw new AppError(
          400,
          'BAD_REQUEST',
          'Choose the exam, unit or subject for this leaderboard.',
        );
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select rank::int as rank, student_id as "studentId", student_name as "studentName",
                      score::float as score, percentage::float as percentage,
                      duration_seconds::int as "durationSeconds", exams_taken as "examsTaken", is_me as "isMe"
               from app.leaderboard($1, $2, $3, $4, $5)`,
              [org(req), f.scope, f.scopeId ?? null, f.pageSize, (f.page - 1) * f.pageSize],
            )
          ).rows,
      );
      return ok({ items: rows, page: f.page, pageSize: f.pageSize }, req.id);
    },
  );

  // ---------- reports ----------
  app.get(
    `${API}/reports/:type`,
    { preHandler: [d.authenticate, requirePermission('report.read')] },
    async (req) => {
      const { type } = z.object({ type: z.enum(REPORTS) }).parse(req.params);
      const f = z
        .object({ examId: z.uuid().optional(), search: z.string().trim().max(100).optional() })
        .parse(req.query);
      const items = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (type === 'exam-performance')
          return (
            await db.query(
              `select e.id as "examId", e.name as "examName", e.exam_code as "examCode", e.status,
                      count(r.id)::int as attempts, count(distinct r.student_id)::int as students,
                      round(avg(r.percentage), 2)::float as "averagePercentage",
                      max(r.percentage)::float as "highestPercentage", min(r.percentage)::float as "lowestPercentage",
                      count(r.id) filter (where r.status = 'Passed')::int as passed,
                      count(r.id) filter (where r.status = 'Failed')::int as failed,
                      round(avg(r.duration_seconds))::int as "averageDurationSeconds"
               from public.exams e
               left join public.results r on r.exam_id = e.id
               where e.organization_id = $1 and e.deleted_at is null and e.status <> 'draft'
               group by e.id order by e.created_at desc limit 200`,
              [org(req)],
            )
          ).rows;
        if (type === 'question-performance') {
          if (!f.examId)
            throw new AppError(400, 'BAD_REQUEST', 'Choose an exam for the question report.');
          const exam = await db.query(
            'select 1 from public.exams where organization_id = $1 and id = $2 and deleted_at is null',
            [org(req), f.examId],
          );
          if (!exam.rowCount) throw notFound('Exam');
          return (
            await db.query(
              `with done as (select id from public.exam_attempts where exam_id = $2 and status = 'submitted')
               select eq.position, q.id as "questionId", q.question_text as "questionText", q.difficulty,
                      eq.marks::float as marks, (select count(*)::int from done) as attempts,
                      count(aa.id) filter (where aa.selected_option_id is not null)::int as answered,
                      count(aa.id) filter (where aa.is_correct)::int as correct,
                      count(aa.id) filter (where aa.is_correct is false)::int as wrong
               from public.exam_questions eq
               join public.questions q on q.id = eq.question_id
               left join public.attempt_answers aa on aa.question_id = eq.question_id and aa.attempt_id in (select id from done)
               where eq.organization_id = $1 and eq.exam_id = $2
               group by eq.position, q.id, eq.marks order by eq.position`,
              [org(req), f.examId],
            )
          ).rows;
        }
        const params: unknown[] = [org(req)];
        const p = f.search ? params.push(likePattern(f.search)) : 0;
        const search = p ? `and (s.full_name ilike $${p} or s.roll_number ilike $${p})` : '';
        return (
          await db.query(
            `select s.id as "studentId", s.full_name as "studentName", s.roll_number as "rollNumber",
                    u.name as "academicUnitName", count(r.id)::int as "examsTaken",
                    round(avg(r.percentage), 2)::float as "averagePercentage", max(r.percentage)::float as "bestPercentage",
                    count(r.id) filter (where r.status = 'Passed')::int as passed, max(r.evaluated_at) as "lastResultAt"
             from public.students s
             join public.results r on r.student_id = s.id
             left join public.academic_units u on u.id = s.academic_unit_id
             where s.organization_id = $1 and s.deleted_at is null ${search}
             group by s.id, u.name order by 6 desc nulls last, 2 limit 500`,
            params,
          )
        ).rows;
      });
      return ok({ type, items }, req.id);
    },
  );

  // ---------- dashboard ----------
  app.get(
    `${API}/organizations/current/dashboard`,
    { preHandler: [d.authenticate, requirePermission('report.read')] },
    async (req) => {
      const data = await withUser(d.pool, req.ctx.userId, async (db) => {
        const totals = (
          await db.query(
            `select
               (select count(*)::int from public.students where organization_id = $1 and deleted_at is null and status = 'active') as students,
               (select count(*)::int from public.teachers where organization_id = $1 and deleted_at is null and status = 'active') as teachers,
               (select count(*)::int from public.courses where organization_id = $1 and deleted_at is null) as courses,
               (select count(*)::int from public.subjects where organization_id = $1 and deleted_at is null) as subjects,
               (select count(*)::int from public.questions where organization_id = $1 and deleted_at is null) as questions,
               (select count(*)::int from public.questions where organization_id = $1 and deleted_at is null and status = 'published') as "publishedQuestions",
               (select count(*)::int from public.exams where organization_id = $1 and deleted_at is null) as exams,
               (select count(*)::int from public.exams where organization_id = $1 and deleted_at is null and status = 'published') as "publishedExams",
               (select count(*)::int from public.exam_attempts where organization_id = $1 and status = 'in_progress' and deadline_at > now()) as "attemptsInProgress"`,
            [org(req)],
          )
        ).rows[0];
        const last30 = (
          await db.query(
            `select count(*)::int as results, round(avg(percentage), 2)::float as "averagePercentage",
                    case when count(*) > 0 then round(100.0 * count(*) filter (where status = 'Passed') / count(*), 2)::float end as "passRate"
             from public.results where organization_id = $1 and evaluated_at >= now() - interval '30 days'`,
            [org(req)],
          )
        ).rows[0];
        const resultsByDay = (
          await db.query(
            `select to_char(d, 'YYYY-MM-DD') as day, count(r.id)::int as results,
                    count(r.id) filter (where r.status = 'Passed')::int as passed
             from generate_series(current_date - 13, current_date, interval '1 day') d
             left join public.results r on r.organization_id = $1 and r.evaluated_at::date = d::date
             group by d order by d`,
            [org(req)],
          )
        ).rows;
        const recentResults = (
          await db.query(
            `select r.id, s.full_name as "studentName", e.name as "examName", r.percentage::float as percentage,
                    r.status, r.evaluated_at as "evaluatedAt"
             from public.results r join public.students s on s.id = r.student_id join public.exams e on e.id = r.exam_id
             where r.organization_id = $1 order by r.evaluated_at desc limit 8`,
            [org(req)],
          )
        ).rows;
        const topExams = (
          await db.query(
            `select e.id as "examId", e.name as "examName", count(r.id)::int as attempts,
                    round(avg(r.percentage), 2)::float as "averagePercentage"
             from public.exams e join public.results r on r.exam_id = e.id
             where e.organization_id = $1 and e.deleted_at is null and r.evaluated_at >= now() - interval '30 days'
             group by e.id order by attempts desc, e.name limit 5`,
            [org(req)],
          )
        ).rows;
        return { totals, last30Days: last30, resultsByDay, recentResults, topExams };
      });
      return ok(data, req.id);
    },
  );
}
