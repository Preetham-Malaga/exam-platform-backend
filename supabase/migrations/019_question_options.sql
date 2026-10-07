-- 019: answer options. NOTE: options never say which one is correct (see 020).
create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  question_id uuid not null,
  option_text text not null check (char_length(btrim(option_text)) > 0),
  position smallint not null check (position >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, question_id, id),
  unique (organization_id, question_id, position),
  foreign key (organization_id, question_id)
    references public.questions (organization_id, id) on delete cascade
);
