-- PURPOSE: Best result per student per exam, maintained at submit time.
-- WHY: Rankings (exam / unit / organization) are cheap reads of this table; subject rankings use attempt_answers.

create table public.leaderboards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  exam_id uuid not null,
  student_id uuid not null,
  best_result_id uuid not null,
  best_score numeric(8, 2) not null,
  best_percentage numeric(5, 2) not null,
  best_duration_seconds int not null,
  attempts_count int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exam_id, student_id),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id),
  foreign key (organization_id, student_id) references public.students (organization_id, id),
  foreign key (organization_id, best_result_id) references public.results (organization_id, id)
);
