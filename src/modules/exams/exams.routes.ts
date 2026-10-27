// PURPOSE: Exam management: exams + settings, the question set, assignment targets, publish / unpublish, soft delete.
// WHY: Guide Part 18 steps 13-14. Teachers see and change only exams they created (RLS exams_*); questions must be
//      published and inside the caller's scope (exam_questions_guard + RLS); the set is frozen once attempts exist.
// DEPENDS ON: tables exams/exam_settings/exam_questions/exam_assignments (022-025), triggers validate_exam_publish,
//             exam_questions_guard, validate_exam_assignment (038), plan limit 'exams'.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { assertActive, idParams, withTotal } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const STATUS = ['draft', 'published', 'unpublished', 'archived'] as const;

const settingsSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    randomizeQuestions: z.boolean(),
    randomizeOptions: z.boolean(),
    showResults: z.boolean(),
    showAnswers: z.boolean(),
    leaderboardEnabled: z.boolean(),
  })
  .strict();
const DEFAULT_SETTINGS: z.infer<typeof settingsSchema> = {
  maxAttempts: 1,
  randomizeQuestions: false,
  randomizeOptions: false,
  showResults: true,
  showAnswers: false,
  leaderboardEnabled: false,
};

const examFields = z.object({
  name: z.string().trim().min(1).max(200),
  examCode: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, ".", "_" or "-" (no spaces).'),
  description: z.string().trim().max(5000).nullable().optional(),
  courseId: z.uuid().nullable().optional(),
  durationMinutes: z.number().int().min(1).max(600),
  passingPercentage: z.number().min(0).max(100),
  startAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const checkWindow = (
  e: { startAt?: string | null; endAt?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (e.startAt && e.endAt && new Date(e.endAt) <= new Date(e.startAt))
    ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'The end must be after the start.' });
};
const createSchema = examFields
  .extend({ settings: settingsSchema.partial().optional() })
  .strict()
  .superRefine(checkWindow);
const updateSchema = examFields
  .partial()
  .extend({ settings: settingsSchema.partial().optional() })
  .strict()
  .superRefine(checkWindow);
const questionsSchema = z.object({ questionIds: z.array(z.uuid()).max(500) }).strict();
const TARGET_TYPES = ['organization', 'academic_unit', 'subject', 'student'] as const;
const assignmentsSchema = z
  .object({
    targets: z
      .array(z.object({ targetType: z.enum(TARGET_TYPES), targetId: z.uuid().optional() }).strict())
      .max(200),
  })
  .strict();

const SORT: Record<string, string> = {
  name: 'e.name',
  examCode: 'e.exam_code',
  startAt: 'e.start_at',
  createdAt: 'e.created_at',
};
const COLUMNS = `e.id, e.exam_code as "examCode", e.name, e.description, e.status,
  e.course_id as "courseId", c.name as "courseName", e.duration_minutes as "durationMinutes",
  e.passing_percentage::float as "passingPercentage", e.start_at as "startAt", e.end_at as "endAt",
  (select count(*)::int from public.exam_questions q where q.exam_id = e.id) as "questionCount",
  (select coalesce(sum(q.marks), 0)::float from public.exam_questions q where q.exam_id = e.id) as "totalMarks",
  (select count(*)::int from public.exam_assignments a where a.exam_id = e.id) as "assignmentCount",
  (select count(*)::int from public.exam_attempts t where t.exam_id = e.id) as "attemptCount",
  coalesce(p.full_name, '') as "createdByName", e.created_by as "createdBy",
  e.created_at as "createdAt", e.updated_at as "updatedAt"`;
const FROM = `public.exams e
  left join public.courses c on c.organization_id = e.organization_id and c.id = e.course_id
  left join public.profiles p on p.id = e.created_by`;

type Row = Record<string, unknown>;

async function getExam(db: Db, org: string, id: string): Promise<Row> {
  const r = await db.query(
    `select ${COLUMNS} from ${FROM} where e.organization_id = $1 and e.id = $2 and e.deleted_at is null`,
    [org, id],
  );
  const exam = r.rows[0] as Row | undefined;
  if (!exam) throw notFound('Exam');
  const s = (
    await db.query(
      `select max_attempts as "maxAttempts", randomize_questions as "randomizeQuestions",
              randomize_options as "randomizeOptions", show_results as "showResults",
              show_answers as "showAnswers", leaderboard_enabled as "leaderboardEnabled"
       from public.exam_settings where organization_id = $1 and exam_id = $2`,
      [org, id],
    )
  ).rows[0];
  const questions = (
    await db.query(
      `select eq.question_id as "questionId", eq.position, eq.marks::float as marks,
              eq.negative_marks::float as "negativeMarks", q.question_text as "questionText",
              q.question_type as "questionType", q.difficulty, q.status, s.name as "subjectName"
       from public.exam_questions eq
       join public.questions q on q.id = eq.question_id
       join public.subjects s on s.id = q.subject_id
       where eq.organization_id = $1 and eq.exam_id = $2 order by eq.position`,
      [org, id],
    )
  ).rows;
  const assignments = (
    await db.query(
      `select a.target_type as "targetType", a.target_id as "targetId",
              case a.target_type
                when 'organization' then (select o.name from public.organizations o where o.id = a.target_id)
                when 'academic_unit' then (select u.name from public.academic_units u where u.id = a.target_id)
                when 'subject' then (select x.name from public.subjects x where x.id = a.target_id)
                when 'student' then (select st.full_name || ' (' || st.roll_number || ')' from public.students st where st.id = a.target_id)
              end as "targetName"
       from public.exam_assignments a where a.organization_id = $1 and a.exam_id = $2
       order by array_position(array['organization','academic_unit','subject','student'], a.target_type), 3`,
      [org, id],
    )
  ).rows;
  return { ...exam, settings: s ?? null, questions, assignments };
}

/** Exams can only change while nobody can take them. */
function assertEditable(exam: Row) {
  if (exam.status === 'published')
    throw new AppError(409, 'EXAM_PUBLISHED', 'Unpublish the exam before changing it.');
}

export function registerExamRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  app.get(
    `${API}/exams`,
    { preHandler: [d.authenticate, requirePermission('exam.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({
          status: z.enum(STATUS).optional(),
          courseId: z.uuid().optional(),
          mine: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['e.organization_id = $1', 'e.deleted_at is null'];
      if (f.status) where.push(`e.status = $${params.push(f.status)}`);
      if (f.courseId) where.push(`e.course_id = $${params.push(f.courseId)}`);
      if (f.mine === 'true') where.push(`e.created_by = $${params.push(req.ctx.userId)}`);
      if (q.search) {
        const p = params.push(likePattern(q.search));
        where.push(`(e.name ilike $${p} or e.exam_code ilike $${p})`);
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${COLUMNS}, count(*) over() as "__total" from ${FROM}
             where ${where.join(' and ')}
             order by ${SORT[q.sort ?? 'createdAt'] ?? SORT.createdAt} ${q.order === 'asc' ? 'asc' : 'desc'} nulls last, e.id
             limit $${params.length - 1} offset $${params.length}`,
              params,
            )
          ).rows,
      );
      const { items, total } = withTotal(rows);
      return ok(paginate(items, total, q), req.id);
    },
  );

  app.get(
    `${API}/exams/:id`,
    { preHandler: [d.authenticate, requirePermission('exam.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(await withUser(d.pool, req.ctx.userId, (db) => getExam(db, org(req), id)), req.id);
    },
  );

  app.post(
    `${API}/exams`,
    { preHandler: [d.authenticate, requirePermission('exam.create')] },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      const s = { ...DEFAULT_SETTINGS, ...body.settings };
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        if (body.courseId) await assertActive(db, 'courses', org(req), body.courseId, 'Course');
        const id = (
          await db.query(
            `insert into public.exams (organization_id, course_id, name, exam_code, description, duration_minutes,
             passing_percentage, start_at, end_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
            [
              org(req),
              body.courseId ?? null,
              body.name,
              body.examCode,
              body.description ?? null,
              body.durationMinutes,
              body.passingPercentage,
              body.startAt ?? null,
              body.endAt ?? null,
            ],
          )
        ).rows[0].id as string;
        await db.query(
          `insert into public.exam_settings (organization_id, exam_id, max_attempts, randomize_questions,
           randomize_options, show_results, show_answers, leaderboard_enabled)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            org(req),
            id,
            s.maxAttempts,
            s.randomizeQuestions,
            s.randomizeOptions,
            s.showResults,
            s.showAnswers,
            s.leaderboardEnabled,
          ],
        );
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_CREATED', 'exams', exam.id as string);
      reply.code(201);
      return ok(exam, req.id);
    },
  );

  app.patch(
    `${API}/exams/:id`,
    { preHandler: [d.authenticate, requirePermission('exam.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = updateSchema.parse(req.body);
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getExam(db, org(req), id);
        assertEditable(current);
        if (body.courseId) await assertActive(db, 'courses', org(req), body.courseId, 'Course');
        const start = body.startAt !== undefined ? body.startAt : (current.startAt as Date | null);
        const end = body.endAt !== undefined ? body.endAt : (current.endAt as Date | null);
        if (start && end && new Date(end) <= new Date(start))
          throw new AppError(400, 'BAD_REQUEST', 'The end must be after the start.');
        const map: Record<string, string> = {
          name: 'name',
          examCode: 'exam_code',
          description: 'description',
          courseId: 'course_id',
          durationMinutes: 'duration_minutes',
          passingPercentage: 'passing_percentage',
          startAt: 'start_at',
          endAt: 'end_at',
        };
        const sets: string[] = [];
        const vals: unknown[] = [];
        for (const [k, col] of Object.entries(map)) {
          const v = (body as Record<string, unknown>)[k];
          if (v !== undefined) sets.push(`${col} = $${vals.push(v)}`);
        }
        if (sets.length) {
          vals.push(req.ctx.userId, org(req), id);
          const n = vals.length;
          await db.query(
            `update public.exams set ${sets.join(', ')}, updated_by = $${n - 2}
           where organization_id = $${n - 1} and id = $${n} and deleted_at is null`,
            vals,
          );
        }
        if (body.settings && Object.keys(body.settings).length) {
          const s = {
            ...DEFAULT_SETTINGS,
            ...((current.settings as typeof DEFAULT_SETTINGS | null) ?? {}),
            ...body.settings,
          };
          await db.query(
            `update public.exam_settings set max_attempts = $1, randomize_questions = $2, randomize_options = $3,
             show_results = $4, show_answers = $5, leaderboard_enabled = $6
           where organization_id = $7 and exam_id = $8`,
            [
              s.maxAttempts,
              s.randomizeQuestions,
              s.randomizeOptions,
              s.showResults,
              s.showAnswers,
              s.leaderboardEnabled,
              org(req),
              id,
            ],
          );
        }
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_UPDATED', 'exams', id, body);
      return ok(exam, req.id);
    },
  );

  // Replaces the question set in the given order. Only published questions in the caller's scope; frozen after attempts.
  app.put(
    `${API}/exams/:id/questions`,
    { preHandler: [d.authenticate, requirePermission('exam.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { questionIds } = questionsSchema.parse(req.body);
      if (new Set(questionIds).size !== questionIds.length)
        throw new AppError(400, 'BAD_REQUEST', 'A question can be added only once.');
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        assertEditable(await getExam(db, org(req), id));
        await db.query(
          'delete from public.exam_questions where organization_id = $1 and exam_id = $2',
          [org(req), id],
        );
        for (const [i, qid] of questionIds.entries())
          await db.query(
            'insert into public.exam_questions (organization_id, exam_id, question_id, position) values ($1,$2,$3,$4)',
            [org(req), id, qid, i + 1],
          );
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_QUESTIONS_SET', 'exams', id, { count: questionIds.length });
      return ok(exam, req.id);
    },
  );

  // Replaces who the exam is assigned to. Allowed while published, so more students can be added to a live exam.
  app.put(
    `${API}/exams/:id/assignments`,
    { preHandler: [d.authenticate, requirePermission('exam.assign')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { targets } = assignmentsSchema.parse(req.body);
      const normalized = targets.map((t) => ({
        targetType: t.targetType,
        targetId: t.targetType === 'organization' ? org(req) : t.targetId,
      }));
      if (normalized.some((t) => !t.targetId))
        throw new AppError(400, 'BAD_REQUEST', 'Choose what to assign the exam to.');
      const unique = [
        ...new Map(normalized.map((t) => [`${t.targetType}:${t.targetId}`, t])).values(),
      ];
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        await getExam(db, org(req), id);
        await db.query(
          'delete from public.exam_assignments where organization_id = $1 and exam_id = $2',
          [org(req), id],
        );
        for (const t of unique)
          await db.query(
            'insert into public.exam_assignments (organization_id, exam_id, target_type, target_id) values ($1,$2,$3,$4)',
            [org(req), id, t.targetType, t.targetId],
          );
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_ASSIGNED', 'exams', id, { targets: unique.length });
      return ok(exam, req.id);
    },
  );

  app.post(
    `${API}/exams/:id/publish`,
    { preHandler: [d.authenticate, requirePermission('exam.publish')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getExam(db, org(req), id);
        if (!(current.assignments as unknown[]).length)
          throw new AppError(
            422,
            'EXAM_NOT_ASSIGNED',
            'Assign the exam to at least one group before publishing.',
          );
        if (current.endAt && new Date(current.endAt as string) <= new Date())
          throw new AppError(422, 'EXAM_ENDED', 'The end time of this exam has already passed.');
        await db.query(
          `update public.exams set status = 'published', updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_PUBLISHED', 'exams', id);
      return ok(exam, req.id);
    },
  );

  app.post(
    `${API}/exams/:id/unpublish`,
    { preHandler: [d.authenticate, requirePermission('exam.unpublish')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const exam = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getExam(db, org(req), id);
        if (current.status !== 'published')
          throw new AppError(409, 'EXAM_NOT_PUBLISHED', 'This exam is not published.');
        await db.query(
          `update public.exams set status = 'unpublished', updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
        return getExam(db, org(req), id);
      });
      await audit(d.pool, req, 'EXAM_UNPUBLISHED', 'exams', id);
      return ok(exam, req.id);
    },
  );

  app.delete(
    `${API}/exams/:id`,
    { preHandler: [d.authenticate, requirePermission('exam.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getExam(db, org(req), id);
        assertEditable(current);
        if ((current.attemptCount as number) > 0)
          throw new AppError(
            409,
            'EXAM_HAS_ATTEMPTS',
            'Students have taken this exam; it is kept for their results.',
          );
        await db.query(
          `update public.exams set deleted_at = now(), updated_by = $1 where organization_id = $2 and id = $3`,
          [req.ctx.userId, org(req), id],
        );
      });
      await audit(d.pool, req, 'EXAM_DELETED', 'exams', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
