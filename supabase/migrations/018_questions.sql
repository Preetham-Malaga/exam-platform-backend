-- 018: question bank. question_types is a lookup table so new types (coding, descriptive...) are an INSERT, not a rewrite.
create table public.question_types (
  code text primary key,
  name text not null,
  is_objective boolean not null default true
);
insert into public.question_types (code, name, is_objective) values
  ('multiple_choice', 'Multiple Choice', true),
  ('true_false', 'True / False', true);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject_id uuid not null,
  topic_id uuid,
  question_type text not null references public.question_types(code),
  question_text text not null check (char_length(btrim(question_text)) > 0),
  difficulty text not null default 'medium' check (difficulty in ('easy','medium','hard')),
  marks numeric(6,2) not null default 1 check (marks > 0),
  negative_marks numeric(6,2) not null default 0 check (negative_marks >= 0),
  explanation text,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  owner_type text not null default 'organization' check (owner_type in ('organization','teacher')),
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, subject_id) references public.subjects (organization_id, id),
  foreign key (organization_id, subject_id, topic_id)
    references public.topics (organization_id, subject_id, id)
);
