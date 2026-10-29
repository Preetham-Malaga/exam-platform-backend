// PURPOSE: Question bank: objective questions (multiple choice, true/false) with options, a protected answer key,
//          draft -> published workflow, filters, and soft delete.
// WHY: Guide Part 18 step 12. Teachers work only inside their scope (RLS app.in_scope on questions, options and keys);
//      students hold no question permission, so they can never read questions or answer keys through the API.
// DEPENDS ON: tables questions/question_options/question_answer_keys (018-020), triggers validate_question_publish and
//             exam_questions_guard (038), plan limit 'questions'.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withSystem, withUser, type Db } from '../../db/context.js';
import { requirePermission } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { likePattern, listQuerySchema, paginate } from '../../utils/pagination.js';
import { ok } from '../../utils/response.js';
import { assertActive, idParams, withTotal } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

export const QUESTION_TYPES = ['multiple_choice', 'true_false'] as const;
const DIFFICULTY = ['easy', 'medium', 'hard'] as const;
const STATUS = ['draft', 'published', 'archived'] as const;

const optionText = z.string().trim().min(1).max(1000);
const marks = z.number().positive().max(1000);

/** The content of a question (shared by create and update). */
const contentFields = z.object({
  subjectId: z.uuid(),
  topicId: z.uuid().nullable().optional(),
  questionType: z.enum(QUESTION_TYPES),
  questionText: z.string().trim().min(1).max(5000),
  difficulty: z.enum(DIFFICULTY).default('medium'),
  marks: marks.default(1),
  negativeMarks: z.number().min(0).max(1000).default(0),
  explanation: z.string().trim().max(5000).nullable().optional(),
  options: z.array(optionText).min(2).max(6),
  /** 0-based index into options. */
  correctOption: z.number().int().min(0).max(5),
});
type Content = z.infer<typeof contentFields>;
const checkContent = (q: Content, ctx: z.RefinementCtx) => {
  if (q.correctOption >= q.options.length)
    ctx.addIssue({
      code: 'custom',
      path: ['correctOption'],
      message: 'Choose one of the options.',
    });
  if (q.questionType === 'true_false' && q.options.length !== 2)
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'True/false questions have exactly 2 options.',
    });
  if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length)
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Options must be different from each other.',
    });
  if (q.negativeMarks > q.marks)
    ctx.addIssue({
      code: 'custom',
      path: ['negativeMarks'],
      message: 'Negative marks cannot exceed the marks.',
    });
};
const contentSchema = contentFields.strict().superRefine(checkContent);
const createSchema = contentFields
  .extend({ publish: z.boolean().default(false) })
  .strict()
  .superRefine(checkContent);
const statusSchema = z.object({ status: z.enum(['draft', 'archived']) }).strict();

const SORT: Record<string, string> = {
  createdAt: 'q.created_at',
  difficulty: "array_position(array['easy','medium','hard'], q.difficulty)",
  marks: 'q.marks',
  status: 'q.status',
};
const COLUMNS = `q.id, q.subject_id as "subjectId", s.name as "subjectName", q.topic_id as "topicId", t.name as "topicName",
  q.question_type as "questionType", q.question_text as "questionText", q.difficulty, q.marks::float as marks,
  q.negative_marks::float as "negativeMarks", q.status, q.owner_type as "ownerType",
  coalesce(p.full_name, '') as "createdByName", q.created_by as "createdBy",
  (select count(*)::int from public.exam_questions eq join public.exams e on e.id = eq.exam_id
    where eq.question_id = q.id and e.deleted_at is null) as "examCount",
  q.created_at as "createdAt", q.updated_at as "updatedAt"`;
const FROM = `public.questions q
  join public.subjects s on s.organization_id = q.organization_id and s.id = q.subject_id
  left join public.topics t on t.organization_id = q.organization_id and t.id = q.topic_id
  left join public.profiles p on p.id = q.created_by`;

type Row = Record<string, unknown>;

async function getQuestion(db: Db, org: string, id: string): Promise<Row> {
  const r = await db.query(
    `select ${COLUMNS}, q.explanation from ${FROM}
     where q.organization_id = $1 and q.id = $2 and q.deleted_at is null`,
    [org, id],
  );
  const q = r.rows[0] as Row | undefined;
  if (!q) throw notFound('Question');
  const options = (
    await db.query(
      'select id, option_text as text, position from public.question_options where organization_id = $1 and question_id = $2 order by position',
      [org, id],
    )
  ).rows;
  const key = (
    await db.query(
      'select correct_option_id from public.question_answer_keys where organization_id = $1 and question_id = $2',
      [org, id],
    )
  ).rows[0];
  return { ...q, options, correctOptionId: key?.correct_option_id ?? null };
}

/** Replaces options + answer key in the caller's RLS session (scope rules apply). */
async function writeContent(
  db: Db,
  org: string,
  questionId: string,
  options: string[],
  correct: number,
): Promise<void> {
  await db.query(
    'delete from public.question_answer_keys where organization_id = $1 and question_id = $2',
    [org, questionId],
  );
  await db.query(
    'delete from public.question_options where organization_id = $1 and question_id = $2',
    [org, questionId],
  );
  const ids: string[] = [];
  for (const [i, text] of options.entries())
    ids.push(
      (
        await db.query(
          `insert into public.question_options (organization_id, question_id, option_text, position)
           values ($1,$2,$3,$4) returning id`,
          [org, questionId, text, i + 1],
        )
      ).rows[0].id as string,
    );
  await db.query(
    `insert into public.question_answer_keys (organization_id, question_id, correct_option_id) values ($1,$2,$3)`,
    [org, questionId, ids[correct]],
  );
}

/** Exams (not deleted) that use the question; answered attempts make its options part of history. */
async function usage(pool: Deps['pool'], org: string, id: string) {
  return withSystem(pool, async (db) => {
    const r = await db.query(
      `select count(distinct e.id)::int as exams,
              count(distinct a.id)::int as attempts
       from public.exam_questions eq
       join public.exams e on e.id = eq.exam_id and e.deleted_at is null
       left join public.exam_attempts a on a.exam_id = e.id
       where eq.organization_id = $1 and eq.question_id = $2`,
      [org, id],
    );
    return r.rows[0] as { exams: number; attempts: number };
  });
}

export function registerQuestionRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;

  app.get(
    `${API}/question-types`,
    { preHandler: [d.authenticate, requirePermission('question.read')] },
    async (req) =>
      ok(
        {
          items: (
            await d.pool.query(
              `select code, name, is_objective as "isObjective" from public.question_types
             where code = any($1) order by name`,
              [QUESTION_TYPES],
            )
          ).rows,
        },
        req.id,
      ),
  );

  app.get(
    `${API}/questions`,
    { preHandler: [d.authenticate, requirePermission('question.read')] },
    async (req) => {
      const q = listQuerySchema.parse(req.query);
      const f = z
        .object({
          courseId: z.uuid().optional(),
          subjectId: z.uuid().optional(),
          topicId: z.uuid().optional(),
          status: z.enum(STATUS).optional(),
          difficulty: z.enum(DIFFICULTY).optional(),
          questionType: z.enum(QUESTION_TYPES).optional(),
          mine: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      const params: unknown[] = [org(req)];
      const where = ['q.organization_id = $1', 'q.deleted_at is null'];
      if (f.courseId) where.push(`s.course_id = $${params.push(f.courseId)}`);
      if (f.subjectId) where.push(`q.subject_id = $${params.push(f.subjectId)}`);
      if (f.topicId) where.push(`q.topic_id = $${params.push(f.topicId)}`);
      if (f.status) where.push(`q.status = $${params.push(f.status)}`);
      if (f.difficulty) where.push(`q.difficulty = $${params.push(f.difficulty)}`);
      if (f.questionType) where.push(`q.question_type = $${params.push(f.questionType)}`);
      if (f.mine === 'true') where.push(`q.created_by = $${params.push(req.ctx.userId)}`);
      if (q.search) where.push(`q.question_text ilike $${params.push(likePattern(q.search))}`);
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = await withUser(
        d.pool,
        req.ctx.userId,
        async (db) =>
          (
            await db.query(
              `select ${COLUMNS}, count(*) over() as "__total" from ${FROM}
               where ${where.join(' and ')}
               order by ${SORT[q.sort ?? 'createdAt'] ?? SORT.createdAt} ${q.order === 'asc' ? 'asc' : 'desc'}, q.id
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
    `${API}/questions/:id`,
    { preHandler: [d.authenticate, requirePermission('question.read')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(
        await withUser(d.pool, req.ctx.userId, (db) => getQuestion(db, org(req), id)),
        req.id,
      );
    },
  );

  app.post(
    `${API}/questions`,
    { preHandler: [d.authenticate, requirePermission('question.create')] },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      if (body.publish && !req.ctx.permissions.includes('question.publish'))
        throw new AppError(403, 'FORBIDDEN', 'You may save the question as a draft only.');
      const isAdmin =
        req.ctx.roles.includes('ORGANIZATION_OWNER') ||
        req.ctx.roles.includes('ORGANIZATION_ADMIN');
      const question = await withUser(d.pool, req.ctx.userId, async (db) => {
        await assertActive(db, 'subjects', org(req), body.subjectId, 'Subject'); // 404 outside the caller's scope
        if (body.topicId) {
          const t = await db.query(
            'select 1 from public.topics where organization_id = $1 and id = $2 and subject_id = $3 and deleted_at is null',
            [org(req), body.topicId, body.subjectId],
          );
          if (!t.rowCount)
            throw new AppError(400, 'INVALID_TOPIC', 'The topic does not belong to this subject.');
        }
        const id = (
          await db.query(
            `insert into public.questions (organization_id, subject_id, topic_id, question_type, question_text,
               difficulty, marks, negative_marks, explanation, owner_type)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
            [
              org(req),
              body.subjectId,
              body.topicId ?? null,
              body.questionType,
              body.questionText,
              body.difficulty,
              body.marks,
              body.negativeMarks,
              body.explanation ?? null,
              isAdmin ? 'organization' : 'teacher',
            ],
          )
        ).rows[0].id as string;
        await writeContent(db, org(req), id, body.options, body.correctOption);
        if (body.publish)
          await db.query(
            `update public.questions set status = 'published' where organization_id = $1 and id = $2`,
            [org(req), id],
          );
        return getQuestion(db, org(req), id);
      });
      await audit(d.pool, req, 'QUESTION_CREATED', 'questions', question.id as string, {
        published: body.publish,
      });
      reply.code(201);
      return ok(question, req.id);
    },
  );

  // Bulk import (CSV parsed in the browser). One transaction per call; each row is checked like a single create, and a
  // row that fails is reported by its row number while the valid rows are saved.
  app.post(
    `${API}/questions/import`,
    { preHandler: [d.authenticate, requirePermission('question.create')] },
    async (req) => {
      const body = z
        .object({
          publish: z.boolean().default(false),
          rows: z.array(z.object({ row: z.number().int().min(1) }).passthrough()).min(1).max(500),
        })
        .strict()
        .parse(req.body);
      if (body.publish && !req.ctx.permissions.includes('question.publish'))
        throw new AppError(403, 'FORBIDDEN', 'You may import questions as drafts only.');
      const isAdmin =
        req.ctx.roles.includes('ORGANIZATION_OWNER') ||
        req.ctx.roles.includes('ORGANIZATION_ADMIN');
      const rowSchema = contentFields.strict().superRefine(checkContent);
      const errors: Array<{ row: number; message: string }> = [];
      let created = 0;
      await withUser(d.pool, req.ctx.userId, async (db) => {
        for (const raw of body.rows) {
          const { row, ...rest } = raw as { row: number } & Record<string, unknown>;
          const parsed = rowSchema.safeParse(rest);
          if (!parsed.success) {
            errors.push({ row, message: parsed.error.issues.map((i) => i.message).join('; ') });
            continue;
          }
          const q = parsed.data;
          const ok1 = await db.query(
            'select 1 from public.subjects where organization_id = $1 and id = $2 and deleted_at is null',
            [org(req), q.subjectId],
          );
          if (!ok1.rowCount) {
            errors.push({ row, message: 'Subject not found.' });
            continue;
          }
          if (q.topicId) {
            const t = await db.query(
              'select 1 from public.topics where organization_id = $1 and id = $2 and subject_id = $3 and deleted_at is null',
              [org(req), q.topicId, q.subjectId],
            );
            if (!t.rowCount) {
              errors.push({ row, message: 'The topic does not belong to this subject.' });
              continue;
            }
          }
          await db.query('savepoint q_row');
          try {
            const id = (
              await db.query(
                `insert into public.questions (organization_id, subject_id, topic_id, question_type, question_text,
                   difficulty, marks, negative_marks, explanation, owner_type, status)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') returning id`,
                [
                  org(req),
                  q.subjectId,
                  q.topicId ?? null,
                  q.questionType,
                  q.questionText,
                  q.difficulty,
                  q.marks,
                  q.negativeMarks,
                  q.explanation ?? null,
                  isAdmin ? 'organization' : 'teacher',
                ],
              )
            ).rows[0].id as string;
            await writeContent(db, org(req), id, q.options, q.correctOption);
            if (body.publish)
              await db.query(
                `update public.questions set status = 'published' where organization_id = $1 and id = $2`,
                [org(req), id],
              );
            await db.query('release savepoint q_row');
            created++;
          } catch (err) {
            await db.query('rollback to savepoint q_row');
            errors.push({ row, message: err instanceof Error ? err.message : 'Could not save this row.' });
          }
        }
      });
      await audit(d.pool, req, 'QUESTIONS_IMPORTED', 'questions', null, {
        created,
        failed: errors.length,
        published: body.publish,
      });
      return ok({ created, errors }, req.id);
    },
  );

  // Full replacement of the content. Refused once an exam that uses the question has attempts (history must not change).
  app.put(
    `${API}/questions/:id`,
    { preHandler: [d.authenticate, requirePermission('question.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const body = contentSchema.parse(req.body);
      const used = await usage(d.pool, org(req), id);
      if (used.attempts > 0)
        throw new AppError(
          409,
          'QUESTION_IN_USE',
          'Students have already answered this question in an exam. Create a new question instead.',
          used,
        );
      const question = await withUser(d.pool, req.ctx.userId, async (db) => {
        const current = await getQuestion(db, org(req), id);
        if (current.status === 'published' && !req.ctx.permissions.includes('question.publish'))
          throw new AppError(
            403,
            'FORBIDDEN',
            'Only users who may publish can edit a published question.',
          );
        await assertActive(db, 'subjects', org(req), body.subjectId, 'Subject');
        if (body.topicId) {
          const t = await db.query(
            'select 1 from public.topics where organization_id = $1 and id = $2 and subject_id = $3 and deleted_at is null',
            [org(req), body.topicId, body.subjectId],
          );
          if (!t.rowCount)
            throw new AppError(400, 'INVALID_TOPIC', 'The topic does not belong to this subject.');
        }
        if (used.exams > 0 && body.subjectId !== current.subjectId)
          throw new AppError(
            409,
            'QUESTION_IN_USE',
            'A question used in an exam cannot move to another subject.',
          );
        const r = await db.query(
          `update public.questions set subject_id = $1, topic_id = $2, question_type = $3, question_text = $4,
             difficulty = $5, marks = $6, negative_marks = $7, explanation = $8, updated_by = $9
           where organization_id = $10 and id = $11 and deleted_at is null`,
          [
            body.subjectId,
            body.topicId ?? null,
            body.questionType,
            body.questionText,
            body.difficulty,
            body.marks,
            body.negativeMarks,
            body.explanation ?? null,
            req.ctx.userId,
            org(req),
            id,
          ],
        );
        if (!r.rowCount) throw notFound('Question');
        await writeContent(db, org(req), id, body.options, body.correctOption);
        return getQuestion(db, org(req), id);
      });
      await audit(d.pool, req, 'QUESTION_UPDATED', 'questions', id);
      return ok(question, req.id);
    },
  );

  app.post(
    `${API}/questions/:id/publish`,
    { preHandler: [d.authenticate, requirePermission('question.publish')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const question = await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.questions set status = 'published', updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Question');
        return getQuestion(db, org(req), id);
      });
      await audit(d.pool, req, 'QUESTION_PUBLISHED', 'questions', id);
      return ok(question, req.id);
    },
  );

  // Back to draft, or archived (hidden from new exams; exams that already use it keep it).
  app.patch(
    `${API}/questions/:id/status`,
    { preHandler: [d.authenticate, requirePermission('question.update')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const { status } = statusSchema.parse(req.body);
      const question = await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.questions set status = $1, updated_by = $2
           where organization_id = $3 and id = $4 and deleted_at is null`,
          [status, req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Question');
        return getQuestion(db, org(req), id);
      });
      await audit(d.pool, req, 'QUESTION_STATUS_CHANGED', 'questions', id, { status });
      return ok(question, req.id);
    },
  );

  app.delete(
    `${API}/questions/:id`,
    { preHandler: [d.authenticate, requirePermission('question.delete')] },
    async (req) => {
      const { id } = idParams.parse(req.params);
      await withUser(d.pool, req.ctx.userId, (db) => getQuestion(db, org(req), id)); // 404 outside scope first
      const used = await usage(d.pool, org(req), id);
      if (used.exams > 0)
        throw new AppError(
          409,
          'QUESTION_IN_USE',
          'This question is part of an exam. Remove it from the exam, or archive it instead.',
          used,
        );
      await withUser(d.pool, req.ctx.userId, async (db) => {
        const r = await db.query(
          `update public.questions set deleted_at = now(), updated_by = $1
           where organization_id = $2 and id = $3 and deleted_at is null`,
          [req.ctx.userId, org(req), id],
        );
        if (!r.rowCount) throw notFound('Question');
      });
      await audit(d.pool, req, 'QUESTION_DELETED', 'questions', id);
      return ok({ deleted: true }, req.id);
    },
  );
}
