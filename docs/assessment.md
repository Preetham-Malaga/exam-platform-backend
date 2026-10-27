# Question bank, exams, exam engine, insights (Phases 11-15)

All rules live in the database (migrations 018-029, 037, 038, 040); the API forwards calls in the caller's own session,
so RLS decides what each person sees: owners/admins everything, teachers their scope (questions) and the exams they
created (exams, results), students only their own attempts and results.

## Question bank (`/questions`)

- Objective types: `multiple_choice` (2-6 options), `true_false` (exactly 2). One correct option, stored separately in
  `question_answer_keys` (students hold no question permission: they can never read questions or keys).
- `POST` creates a draft, or publishes at once with `publish: true` (needs `question.publish`). A question can be
  published only when complete (trigger `validate_question_publish`).
- `PUT` replaces the content; refused (`409 QUESTION_IN_USE`) once students answered it in an exam.
- `PATCH /:id/status` draft/archived; `DELETE` soft-deletes, refused while an exam uses the question.
- Teachers create only in subjects inside their scope (outside: `404`); `owner_type` is `teacher` or `organization`.

## Exams (`/exams`)

- Create with settings (attempts, shuffling, show results/answers, leaderboard). Editable only while not published.
- `PUT /:id/questions` replaces the ordered set: published questions inside the caller's scope only; marks are
  snapshotted; frozen once any attempt exists (`EXAM_HAS_ATTEMPTS`).
- `PUT /:id/assignments`: organization, academic units (include every unit below), subjects, individual students.
- `POST /:id/publish` needs settings, questions and at least one assignment (`EXAM_NOT_ASSIGNED`); `unpublish` stops
  new starts. Exams with attempts cannot be deleted.

## Student exam engine

`GET /student/exams` -> `POST /exams/:id/start` (resumes a running attempt; server sets the deadline) ->
`GET /attempts/:id` (paper without keys) -> `POST /attempts/:id/answers` (auto-save) -> `POST /attempts/:id/submit`
(idempotent; evaluated on the server; auto-submitted after the deadline) -> `GET /student/results`,
`GET /attempts/:id/review` (correct answers only if the exam allows it).

## Insights

`GET /results` (+ `/results/:id` with every answer), `GET /leaderboards?scope=exam|organization|academic_unit|subject`,
`GET /reports/exam-performance | question-performance?examId= | student-performance`,
`GET /organizations/current/dashboard` (totals, 30 days, results per day, recent results, top exams).

## Screens

Owners/admins: `/org/dashboard`, `/org/questions`, `/org/exams` (+ `/published`, `/:examId`), `/org/assignments`,
`/org/results`, `/org/leaderboard`, `/org/reports`. Teachers: the same under `/teacher/*` (dashboard, questions,
exams, results). Students: `/student/dashboard`, `/student/exams`, `/student/attempts/:id`, `/student/results`,
`/student/leaderboard`.

## Not yet

Descriptive (manually marked) questions, bulk question import, PDF/Excel export of reports, bulk e-mail invitations
(needs the job queue).
