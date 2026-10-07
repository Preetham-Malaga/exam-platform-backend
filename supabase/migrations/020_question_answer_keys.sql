-- 020: correct answers live in their own table so they can be protected separately.
-- answer_payload is reserved for future types (multi-select, short answer, coding test cases).
create table public.question_answer_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  question_id uuid not null,
  correct_option_id uuid,
  answer_payload jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, question_id),
  foreign key (organization_id, question_id)
    references public.questions (organization_id, id) on delete cascade,
  foreign key (organization_id, question_id, correct_option_id)
    references public.question_options (organization_id, question_id, id)
);
