-- PURPOSE: Exam definitions. Scheduling and scoring knobs; behaviour switches are in exam_settings.

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  course_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  exam_code text not null check (char_length(btrim(exam_code)) between 1 and 50),
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'unpublished', 'archived')),
  duration_minutes int not null check (duration_minutes between 1 and 600),
  passing_percentage numeric(5, 2) not null default 40 check (passing_percentage between 0 and 100),
  start_at timestamptz,
  end_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id),
  updated_by uuid references auth.users (id),
  deleted_at timestamptz,
  unique (organization_id, id),
  check (end_at is null or start_at is null or end_at > start_at),
  foreign key (organization_id, course_id) references public.courses (organization_id, id)
);
create unique index exams_org_code_uq on public.exams (organization_id, lower(exam_code)) where deleted_at is null;
