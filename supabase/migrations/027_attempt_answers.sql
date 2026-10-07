-- PURPOSE: The student's saved answers (auto-save writes here). is_correct / marks_awarded are filled
--          by server-side evaluation at submit time.
-- The composite FK on selected_option_id proves the option belongs to that question.

create table public.attempt_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  attempt_id uuid not null,
  question_id uuid not null,
  selected_option_id uuid,
  answer_text text,
  flagged boolean not null default false,
  is_correct boolean,
  marks_awarded numeric(7, 2),
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_id),
  foreign key (organization_id, attempt_id) references public.exam_attempts (organization_id, id) on delete cascade,
  foreign key (organization_id, question_id) references public.questions (organization_id, id),
  foreign key (organization_id, question_id, selected_option_id)
    references public.question_options (organization_id, question_id, id)
);
