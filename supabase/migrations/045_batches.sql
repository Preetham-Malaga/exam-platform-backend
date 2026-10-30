-- 045: Batches (prototype People › Batches, SPEC.batch): how students are grouped. Exams, classes and materials reach
-- students through their batch. Students get an optional batch_id.
-- Only additions: a new table and a nullable column. No existing row or value changes.
-- Undo: supabase/rollbacks/045_batches.down.sql

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  course_id uuid,
  code text not null check (char_length(btrim(code)) between 1 and 30),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  academic_year text check (academic_year is null or char_length(academic_year) <= 20),
  year_sem text check (year_sem is null or char_length(year_sem) <= 30),
  section text check (section is null or char_length(section) <= 10),
  mode text check (mode is null or mode in ('Offline', 'Online', 'Hybrid')),
  timing text check (timing is null or timing in ('Morning', 'Afternoon', 'Evening', 'Weekend')),
  start_date date,
  end_date date,
  capacity int check (capacity is null or capacity between 1 and 1000),
  class_teacher_id uuid,
  room text check (room is null or char_length(room) <= 30),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid default auth.uid() references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id),
  check (end_date is null or start_date is null or end_date >= start_date),
  foreign key (organization_id, course_id) references public.courses (organization_id, id),
  foreign key (organization_id, class_teacher_id) references public.teachers (organization_id, id)
);
create unique index batches_org_code_uq on public.batches (organization_id, lower(code)) where deleted_at is null;
create index batches_org_course_idx on public.batches (organization_id, course_id) where deleted_at is null;
create trigger trg_set_updated_at before update on public.batches
  for each row execute function app.set_updated_at();

alter table public.students add column batch_id uuid;
alter table public.students
  add constraint students_batch_fk foreign key (organization_id, batch_id)
  references public.batches (organization_id, id);
create index students_org_batch_idx on public.students (organization_id, batch_id) where deleted_at is null;

-- Privileges and RLS: batches are part of student management, so they follow the student permissions.
revoke all on table public.batches from anon;
revoke truncate, references, trigger on table public.batches from authenticated;
alter table public.batches enable row level security;
create policy batches_select on public.batches for select to authenticated
  using (app.has_permission(organization_id, 'student.read'));
create policy batches_insert on public.batches for insert to authenticated
  with check (app.has_permission(organization_id, 'student.create'));
create policy batches_update on public.batches for update to authenticated
  using (app.has_permission(organization_id, 'student.update'))
  with check (app.has_permission(organization_id, 'student.update'));
create policy batches_delete on public.batches for delete to authenticated
  using (app.has_permission(organization_id, 'student.delete'));
