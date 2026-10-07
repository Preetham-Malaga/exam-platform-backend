-- PURPOSE: One row per attempt. The server stores started_at and deadline_at; the browser clock is display-only.
-- question_order / option_orders freeze the randomized order so refreshes show the same paper.

create table public.exam_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  exam_id uuid not null,
  student_id uuid not null,
  attempt_no int not null check (attempt_no > 0),
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  auto_submitted boolean not null default false,
  question_order uuid[] not null,
  option_orders jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (exam_id, student_id, attempt_no),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id),
  foreign key (organization_id, student_id) references public.students (organization_id, id)
);
-- A student can have only ONE running attempt per exam (blocks double-start races).
create unique index exam_attempts_one_running on public.exam_attempts (exam_id, student_id) where status = 'in_progress';
