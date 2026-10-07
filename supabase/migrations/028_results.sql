-- PURPOSE: Evaluated outcome of a submitted attempt. unique(attempt_id) makes double-submit harmless.

create table public.results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  attempt_id uuid not null unique,
  student_id uuid not null,
  exam_id uuid not null,
  score numeric(8, 2) not null,
  maximum_score numeric(8, 2) not null,
  percentage numeric(5, 2) not null,
  correct_count int not null,
  wrong_count int not null,
  unanswered_count int not null,
  duration_seconds int not null,
  status text not null check (status in ('Passed', 'Failed', 'Pending')),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (organization_id, attempt_id) references public.exam_attempts (organization_id, id),
  foreign key (organization_id, student_id) references public.students (organization_id, id),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id),
  unique (organization_id, id)
);
