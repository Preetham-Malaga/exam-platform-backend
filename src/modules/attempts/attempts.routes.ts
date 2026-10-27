// PURPOSE: The student side of the exam engine: available exams, start (or resume), the paper, auto-save, submit,
//          own results and the review of a submitted attempt.
// WHY: Guide Part 9 / Part 18 step 15. Every rule lives in the database functions (037): the server sets the deadline,
//      answer keys never leave the server, submit is idempotent, and only the attempt's own student can touch it.
//      These routes only forward the call in the student's own session.
// DEPENDS ON: SQL app.available_exams, start_attempt, get_attempt, save_answer, submit_attempt, my_results,
//             get_attempt_review (037).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../../db/context.js';
import { requireOrganization } from '../../middleware/authorization.js';
import { audit } from '../../utils/audit.js';
import { ok } from '../../utils/response.js';
import { idParams } from '../academic/shared.js';
import { API, type Deps } from '../deps.js';

const answerSchema = z
  .object({
    questionId: z.uuid(),
    optionId: z.uuid().nullable(),
    flagged: z.boolean().default(false),
  })
  .strict();

export function registerAttemptRoutes(app: FastifyInstance, d: Deps): void {
  const org = (req: { ctx: { organization: { id: string } | null } }) => req.ctx.organization!.id;
  const guard = { preHandler: [d.authenticate, requireOrganization()] };

  app.get(`${API}/student/exams`, guard, async (req) => {
    const rows = await withUser(
      d.pool,
      req.ctx.userId,
      async (db) =>
        (
          await db.query(
            `select exam_id as "examId", exam_code as "examCode", name, description,
                    duration_minutes as "durationMinutes", passing_percentage::float as "passingPercentage",
                    start_at as "startAt", end_at as "endAt", max_attempts as "maxAttempts",
                    attempts_used as "attemptsUsed", running_attempt_id as "runningAttemptId",
                    show_results as "showResults", leaderboard_enabled as "leaderboardEnabled",
                    question_count as "questionCount", total_marks::float as "totalMarks"
             from app.available_exams($1)`,
            [org(req)],
          )
        ).rows,
    );
    return ok({ items: rows }, req.id);
  });

  app.post(`${API}/exams/:id/start`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const r = await withUser(d.pool, req.ctx.userId, (db) =>
      db.query('select app.start_attempt($1, $2) as r', [org(req), id]),
    );
    const attempt = r.rows[0].r as Record<string, unknown>;
    await audit(d.pool, req, 'ATTEMPT_STARTED', 'exam_attempts', attempt.attemptId as string, {
      examId: id,
    });
    return ok(attempt, req.id);
  });

  app.get(`${API}/attempts/:id`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const r = await withUser(d.pool, req.ctx.userId, (db) =>
      db.query('select app.get_attempt($1, $2) as r', [org(req), id]),
    );
    return ok(r.rows[0].r, req.id);
  });

  app.post(`${API}/attempts/:id/answers`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const a = answerSchema.parse(req.body);
    const r = await withUser(d.pool, req.ctx.userId, (db) =>
      db.query('select app.save_answer($1, $2, $3, $4, null, $5) as r', [
        org(req),
        id,
        a.questionId,
        a.optionId,
        a.flagged,
      ]),
    );
    return ok(r.rows[0].r, req.id);
  });

  app.post(`${API}/attempts/:id/submit`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const r = await withUser(d.pool, req.ctx.userId, (db) =>
      db.query('select app.submit_attempt($1, $2) as r', [org(req), id]),
    );
    await audit(d.pool, req, 'ATTEMPT_SUBMITTED', 'exam_attempts', id);
    return ok(r.rows[0].r, req.id);
  });

  app.get(`${API}/student/results`, guard, async (req) => {
    const rows = await withUser(
      d.pool,
      req.ctx.userId,
      async (db) =>
        (
          await db.query(
            `select result_id as "resultId", attempt_id as "attemptId", exam_id as "examId", exam_name as "examName",
                    score::float as score, maximum_score::float as "maximumScore", percentage::float as percentage,
                    correct_count as "correctCount", wrong_count as "wrongCount", unanswered_count as "unansweredCount",
                    duration_seconds as "durationSeconds", status, evaluated_at as "evaluatedAt",
                    show_answers as "showAnswers", leaderboard_enabled as "leaderboardEnabled"
             from app.my_results($1)`,
            [org(req)],
          )
        ).rows,
    );
    return ok({ items: rows }, req.id);
  });

  app.get(`${API}/attempts/:id/review`, guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const r = await withUser(d.pool, req.ctx.userId, (db) =>
      db.query('select app.get_attempt_review($1, $2) as r', [org(req), id]),
    );
    return ok(r.rows[0].r, req.id);
  });
}
