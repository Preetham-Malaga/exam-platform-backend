-- PURPOSE: Behaviour switches of an exam (attempt limit, randomization, what the student may see).

create table public.exam_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  exam_id uuid not null unique,
  max_attempts int not null default 1 check (max_attempts between 1 and 20),
  randomize_questions boolean not null default false,
  randomize_options boolean not null default false,
  show_results boolean not null default true,
  show_answers boolean not null default false,
  leaderboard_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id) on delete cascade
);
