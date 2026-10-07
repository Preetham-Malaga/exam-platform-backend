-- PURPOSE: Who an exam is assigned to: organization, academic unit, subject or selected students.
-- NOTE: target_id is polymorphic, so a trigger (038) verifies it points at a row of the same organization.

create table public.exam_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  exam_id uuid not null,
  target_type text not null check (target_type in ('organization', 'academic_unit', 'subject', 'student')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id),
  unique (exam_id, target_type, target_id),
  foreign key (organization_id, exam_id) references public.exams (organization_id, id) on delete cascade
);
