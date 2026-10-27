// Phases 11-15: question bank -> exam -> assignment -> publish -> student attempt -> results / leaderboard /
// reports / dashboard, on the real app + real PostgreSQL. Every step also checks who may NOT do it.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_TEST_URL, createTenant, pool, type Tenant } from '../db/helpers.js';
import { Client, makeApp } from './harness.js';

const code = (p = 'E') => `${p}${randomUUID().slice(0, 8)}`;
const mcq = (subjectId: string, over: Record<string, unknown> = {}) => ({
  subjectId,
  questionType: 'multiple_choice',
  questionText: `What is 2 + 2? ${randomUUID().slice(0, 4)}`,
  difficulty: 'easy',
  marks: 2,
  negativeMarks: 0.5,
  options: ['3', '4', '5', '22'],
  correctOption: 1,
  publish: true,
  ...over,
});

describe.skipIf(!DATABASE_TEST_URL)(
  'Question bank, exams, exam engine and insights (real app + DB)',
  () => {
    let app: FastifyInstance;
    let A: Tenant;
    let B: Tenant;
    const as = (id?: string) => new Client(app, id);

    beforeAll(async () => {
      app = await makeApp();
      A = await createTenant('flowA');
      B = await createTenant('flowB');
    });
    afterAll(async () => {
      await app.close();
      await pool.end();
    });

    describe('question bank', () => {
      it('a teacher creates and publishes a question in their subject; the key is stored separately', async () => {
        const r = await as(A.teacher1).post('/questions', mcq(A.subject1));
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        const q = r.body.data;
        expect(q).toMatchObject({
          status: 'published',
          ownerType: 'teacher',
          marks: 2,
          negativeMarks: 0.5,
        });
        expect(q.options.map((o: any) => o.text)).toEqual(['3', '4', '5', '22']);
        expect(q.correctOptionId).toBe(q.options[1].id);
        const key = await pool.query(
          'select correct_option_id from question_answer_keys where question_id = $1',
          [q.id],
        );
        expect(key.rows[0].correct_option_id).toBe(q.options[1].id);
      });

      it('scope: a subject outside the teacher scope does not exist for them', async () => {
        expect((await as(A.teacher1).post('/questions', mcq(A.subject2))).status).toBe(404);
        const mine = (await as(A.teacher1).post('/questions', mcq(A.subject1))).body.data.id;
        expect((await as(A.teacher2).get(`/questions/${mine}`)).status).toBe(404);
        const list = (await as(A.teacher2).get('/questions?pageSize=100')).body.data.items.map(
          (x: any) => x.subjectId,
        );
        expect(new Set(list)).toEqual(new Set([A.subject2]));
      });

      it('students can never read questions or answer keys', async () => {
        expect((await as(A.student).get('/questions')).status).toBe(403);
        expect((await as(A.student).get(`/questions/${A.q1}`)).status).toBe(403);
      });

      it('validates content: true/false has 2 options, the answer must be an option, options differ', async () => {
        const bad = [
          mcq(A.subject1, { questionType: 'true_false', options: ['T', 'F', 'X'] }),
          mcq(A.subject1, { correctOption: 4 }),
          mcq(A.subject1, { options: ['A', 'a'] }),
          mcq(A.subject1, { negativeMarks: 5 }),
        ];
        for (const b of bad) expect((await as(A.owner).post('/questions', b)).status).toBe(400);
      });

      it('draft -> edit -> publish -> archive; a question in an exam cannot be deleted', async () => {
        const d = (await as(A.owner).post('/questions', mcq(A.subject1, { publish: false }))).body
          .data;
        expect(d.status).toBe('draft');
        const { publish: _p, ...content } = mcq(A.subject1, {
          questionText: 'Edited text',
          options: ['Yes', 'No'],
          correctOption: 0,
        });
        const ed = await as(A.owner).put(`/questions/${d.id}`, content);
        expect(ed.body.data).toMatchObject({ questionText: 'Edited text', status: 'draft' });
        expect(ed.body.data.options).toHaveLength(2);
        expect((await as(A.owner).post(`/questions/${d.id}/publish`)).body.data.status).toBe(
          'published',
        );
        expect(
          (await as(A.owner).patch(`/questions/${d.id}/status`, { status: 'archived' })).body.data
            .status,
        ).toBe('archived');
        const inExam = await as(A.owner).del(`/questions/${A.q1}`);
        expect(inExam.status).toBe(409);
        expect(inExam.body.error.code).toBe('QUESTION_IN_USE');
      });
    });

    describe('exam lifecycle and student attempt', () => {
      let examId: string;
      let qPub: { id: string; options: Array<{ id: string }>; correctOptionId: string };
      let qDraft: string;
      let attemptId: string;
      let resultId: string;

      it('a teacher creates an exam with settings', async () => {
        qPub = (await as(A.teacher1).post('/questions', mcq(A.subject1))).body.data;
        qDraft = (await as(A.teacher1).post('/questions', mcq(A.subject1, { publish: false }))).body
          .data.id;
        const r = await as(A.teacher1).post('/exams', {
          name: 'Unit Test 1',
          examCode: code(),
          durationMinutes: 30,
          passingPercentage: 50,
          settings: { maxAttempts: 1, showAnswers: false, leaderboardEnabled: false },
        });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.data).toMatchObject({
          status: 'draft',
          questionCount: 0,
          settings: { maxAttempts: 1, showResults: true },
        });
        examId = r.body.data.id;
      });

      it('questions: only published ones, only inside the teacher scope', async () => {
        const draft = await as(A.teacher1).put(`/exams/${examId}/questions`, {
          questionIds: [qDraft],
        });
        expect(draft.status).toBe(422);
        expect(draft.body.error.code).toBe('QUESTION_NOT_PUBLISHED');
        expect(
          (await as(A.teacher1).put(`/exams/${examId}/questions`, { questionIds: [A.q2] })).status,
        ).toBe(403);
        const ok = await as(A.teacher1).put(`/exams/${examId}/questions`, {
          questionIds: [qPub.id],
        });
        expect(ok.body.data).toMatchObject({ questionCount: 1, totalMarks: 2 });
      });

      it('publish needs an assignment; published exams are locked; other teachers cannot see it', async () => {
        const early = await as(A.teacher1).post(`/exams/${examId}/publish`);
        expect(early.body.error.code).toBe('EXAM_NOT_ASSIGNED');
        const asg = await as(A.teacher1).put(`/exams/${examId}/assignments`, {
          targets: [{ targetType: 'academic_unit', targetId: A.unitId }],
        });
        expect(asg.body.data.assignments).toEqual([
          expect.objectContaining({
            targetType: 'academic_unit',
            targetId: A.unitId,
            targetName: 'Unit 1',
          }),
        ]);
        expect((await as(A.teacher1).post(`/exams/${examId}/publish`)).body.data.status).toBe(
          'published',
        );
        const locked = await as(A.teacher1).patch(`/exams/${examId}`, { name: 'Changed' });
        expect(locked.body.error.code).toBe('EXAM_PUBLISHED');
        expect((await as(A.teacher2).get(`/exams/${examId}`)).status).toBe(404);
        expect((await as(A.student).get(`/exams/${examId}`)).status).toBe(403);
      });

      it('a student on the unit sees the exam, starts it and gets the paper WITHOUT answers', async () => {
        const list = (await as(A.student).get('/student/exams')).body.data.items;
        expect(list.map((e: any) => e.examId)).toContain(examId);
        const start = await as(A.student).post(`/exams/${examId}/start`);
        expect(start.status).toBe(200);
        attemptId = start.body.data.attemptId;
        expect(new Date(start.body.data.deadlineAt).getTime()).toBeGreaterThan(
          Date.now() + 29 * 60_000,
        );
        const again = await as(A.student).post(`/exams/${examId}/start`);
        expect(again.body.data.attemptId).toBe(attemptId); // resume, not a second attempt
        const paper = await as(A.student).get(`/attempts/${attemptId}`);
        expect(paper.body.data.questions).toHaveLength(1);
        expect(paper.raw).not.toMatch(/correct/i); // no key, no isCorrect anywhere in the paper
        expect((await as(A.student2).get(`/attempts/${attemptId}`)).status).toBe(404);
      });

      it('auto-save, submit (twice = same result), then no more attempts', async () => {
        const save = await as(A.student).post(`/attempts/${attemptId}/answers`, {
          questionId: qPub.id,
          optionId: qPub.correctOptionId,
        });
        expect(save.body.data.saved).toBe(true);
        const s1 = await as(A.student).post(`/attempts/${attemptId}/submit`);
        expect(s1.body.data.result).toMatchObject({
          score: 2,
          maximumScore: 2,
          percentage: 100,
          status: 'Passed',
        });
        resultId = s1.body.data.result.resultId;
        const s2 = await as(A.student).post(`/attempts/${attemptId}/submit`);
        expect(s2.body.data.result.resultId).toBe(resultId);
        const late = await as(A.student).post(`/attempts/${attemptId}/answers`, {
          questionId: qPub.id,
          optionId: null,
        });
        expect(late.body.error.code).toBe('ATTEMPT_CLOSED');
        const more = await as(A.student).post(`/exams/${examId}/start`);
        expect(more.body.error.code).toBe('MAX_ATTEMPTS_REACHED');
        const mine = (await as(A.student).get('/student/results')).body.data.items;
        expect(mine.map((r: any) => r.resultId)).toContain(resultId);
        const review = await as(A.student).get(`/attempts/${attemptId}/review`);
        expect(review.body.data).toMatchObject({ showAnswers: false, review: null }); // answers hidden by the exam setting
      });

      it('the question set is frozen once an attempt exists', async () => {
        await as(A.teacher1).post(`/exams/${examId}/unpublish`);
        const r = await as(A.teacher1).put(`/exams/${examId}/questions`, { questionIds: [] });
        expect(r.body.error.code).toBe('EXAM_HAS_ATTEMPTS');
        const del = await as(A.teacher1).del(`/exams/${examId}`);
        expect(del.body.error.code).toBe('EXAM_HAS_ATTEMPTS');
        const edit = await as(A.teacher1).put(`/questions/${qPub.id}`, {
          ...mcq(A.subject1),
          publish: undefined,
        });
        expect(edit.status).toBe(409);
      });

      it('insights: results, detail with answers, reports and leaderboard follow the exam owner', async () => {
        const results = (await as(A.teacher1).get(`/results?examId=${examId}`)).body.data;
        expect(results.items).toHaveLength(1);
        expect(results.items[0]).toMatchObject({
          studentName: 'Student One',
          percentage: 100,
          status: 'Passed',
        });
        expect((await as(A.teacher2).get(`/results?examId=${examId}`)).body.data.items).toEqual([]);
        const detail = (await as(A.owner).get(`/results/${resultId}`)).body.data;
        expect(detail.answers[0]).toMatchObject({
          correctOptionId: qPub.correctOptionId,
          isCorrect: true,
          marksAwarded: 2,
        });
        expect((await as(A.student).get(`/results/${resultId}`)).status).toBe(403);

        const perf = (await as(A.owner).get('/reports/exam-performance')).body.data.items.find(
          (x: any) => x.examId === examId,
        );
        expect(perf).toMatchObject({
          attempts: 1,
          students: 1,
          averagePercentage: 100,
          passed: 1,
          failed: 0,
        });
        const qp = (await as(A.teacher1).get(`/reports/question-performance?examId=${examId}`)).body
          .data.items;
        expect(qp[0]).toMatchObject({ attempts: 1, answered: 1, correct: 1, wrong: 0 });
        const sp = (await as(A.owner).get('/reports/student-performance?search=Student%20One')).body
          .data.items;
        expect(sp[0]).toMatchObject({ studentName: 'Student One', examsTaken: 1 });
        expect((await as(A.student).get('/reports/exam-performance')).status).toBe(403);

        const lbOwner = (await as(A.owner).get(`/leaderboards?scope=exam&scopeId=${examId}`)).body
          .data.items;
        expect(lbOwner[0]).toMatchObject({ rank: 1, studentName: 'Student One', percentage: 100 });
        expect((await as(A.student).get(`/leaderboards?scope=exam&scopeId=${examId}`)).status).toBe(
          403,
        ); // disabled
      });

      it('dashboard totals are scoped by RLS', async () => {
        const own = (await as(A.owner).get('/organizations/current/dashboard')).body.data;
        expect(own.totals.students).toBe(2);
        expect(own.last30Days.results).toBeGreaterThanOrEqual(1);
        expect(own.resultsByDay).toHaveLength(14);
        expect(own.recentResults[0]).toMatchObject({ studentName: 'Student One' });
        const t2 = (await as(A.teacher2).get('/organizations/current/dashboard')).body.data;
        expect(t2.last30Days.results).toBe(0); // teacher2 sees no results of teacher1's exam
        expect((await as(A.student).get('/organizations/current/dashboard')).status).toBe(403);
      });
    });

    describe('tenant isolation', () => {
      it("College A cannot reach College B's questions, exams or results; B's student cannot start A's exam", async () => {
        expect((await as(A.owner).get(`/questions/${B.q1}`)).status).toBe(404);
        expect((await as(A.owner).get(`/exams/${B.examId}`)).status).toBe(404);
        expect(
          (await as(A.owner).put(`/exams/${B.examId}/assignments`, { targets: [] })).status,
        ).toBe(404);
        expect((await as(B.student).post(`/exams/${A.examId}/start`)).status).toBe(404);
        const qs = (await as(A.owner).get('/questions?pageSize=100')).body.data.items.map(
          (x: any) => x.id,
        );
        expect(qs).not.toContain(B.q1);
        const assignForeign = await as(A.owner).put(`/exams/${A.examId}/assignments`, {
          targets: [{ targetType: 'student', targetId: B.studentId }],
        });
        expect(assignForeign.status).toBe(400);
      });
    });
  },
);
